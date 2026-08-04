CREATE OR REPLACE FUNCTION dasher_api.get_dashboard_admin_status(uuid)
RETURNS dasher.dashboard_admin_projection
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_result dasher.dashboard_admin_projection;
  v_now timestamptz := statement_timestamp();
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
    AND dashboard.dashboard_id = $1
    AND NOT (
      dashboard.current_kind = 'disposable'
      AND dashboard.effective_expires_at IS NOT NULL
      AND v_now >= dashboard.effective_expires_at
    );
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  RETURN v_result;
END
$function$;

GRANT UPDATE (head_version_id) ON TABLE dasher.dashboards
  TO dasher_retention_definer;

DROP POLICY source_snapshots_retention_select ON dasher.source_snapshots;
DROP POLICY source_snapshots_retention_delete ON dasher.source_snapshots;
DROP POLICY evidence_records_retention_select ON dasher.evidence_records;
DROP POLICY evidence_records_retention_delete ON dasher.evidence_records;

CREATE POLICY source_snapshots_retention_select
ON dasher.source_snapshots
AS PERMISSIVE
FOR SELECT
TO dasher_retention_definer
USING (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (EXISTS (SELECT 1 FROM dasher.snapshot_reference_claims AS target_claim WHERE target_claim.organization_id = source_snapshots.organization_id AND target_claim.snapshot_id = source_snapshots.snapshot_id AND target_claim.dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid) OR EXISTS (SELECT 1 FROM dasher.snapshot_deletion_finalizers AS target_finalizer JOIN dasher.dashboard_cleanup_coordination AS target_cleanup ON target_cleanup.organization_id = target_finalizer.organization_id WHERE target_finalizer.organization_id = source_snapshots.organization_id AND target_finalizer.snapshot_id = source_snapshots.snapshot_id AND target_cleanup.organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid AND target_cleanup.dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid AND target_cleanup.current_step = 'purge_finalizing'::text AND target_cleanup.expected_lifecycle_revision = (current_setting('dasher.retention_expected_lifecycle_revision'::text, true))::bigint AND octet_length(target_cleanup.completion_proof_sha256) = 32 AND target_cleanup.lease_owner IS NULL AND target_cleanup.lease_expires_at IS NULL AND target_finalizer.state = 'deleted'::text AND target_finalizer.proof_sha256 = target_finalizer.expected_claim_set_sha256 AND target_finalizer.bytes_deleted_at IS NOT NULL AND target_finalizer.bytes_deleted_at >= target_finalizer.intent_at AND target_finalizer.expected_claim_set_sha256 = sha256((((uuid_send(source_snapshots.organization_id) || uuid_send((current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)) || uuid_send(source_snapshots.snapshot_id)) || convert_to('snapshot|expected_claim_set=empty'::text, 'UTF8'::name))) AND NOT EXISTS (SELECT 1 FROM dasher.snapshot_reference_claims AS remaining_claim WHERE remaining_claim.organization_id = source_snapshots.organization_id AND remaining_claim.snapshot_id = source_snapshots.snapshot_id)))))
;
CREATE POLICY source_snapshots_retention_delete
ON dasher.source_snapshots
AS PERMISSIVE
FOR DELETE
TO dasher_retention_definer
USING (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (EXISTS (SELECT 1 FROM dasher.snapshot_reference_claims AS target_claim WHERE target_claim.organization_id = source_snapshots.organization_id AND target_claim.snapshot_id = source_snapshots.snapshot_id AND target_claim.dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid) OR EXISTS (SELECT 1 FROM dasher.snapshot_deletion_finalizers AS target_finalizer JOIN dasher.dashboard_cleanup_coordination AS target_cleanup ON target_cleanup.organization_id = target_finalizer.organization_id WHERE target_finalizer.organization_id = source_snapshots.organization_id AND target_finalizer.snapshot_id = source_snapshots.snapshot_id AND target_cleanup.organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid AND target_cleanup.dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid AND target_cleanup.current_step = 'purge_finalizing'::text AND target_cleanup.expected_lifecycle_revision = (current_setting('dasher.retention_expected_lifecycle_revision'::text, true))::bigint AND octet_length(target_cleanup.completion_proof_sha256) = 32 AND target_cleanup.lease_owner IS NULL AND target_cleanup.lease_expires_at IS NULL AND target_finalizer.state = 'deleted'::text AND target_finalizer.proof_sha256 = target_finalizer.expected_claim_set_sha256 AND target_finalizer.bytes_deleted_at IS NOT NULL AND target_finalizer.bytes_deleted_at >= target_finalizer.intent_at AND target_finalizer.expected_claim_set_sha256 = sha256((((uuid_send(source_snapshots.organization_id) || uuid_send((current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)) || uuid_send(source_snapshots.snapshot_id)) || convert_to('snapshot|expected_claim_set=empty'::text, 'UTF8'::name))) AND NOT EXISTS (SELECT 1 FROM dasher.snapshot_reference_claims AS remaining_claim WHERE remaining_claim.organization_id = source_snapshots.organization_id AND remaining_claim.snapshot_id = source_snapshots.snapshot_id)))))
;
CREATE POLICY evidence_records_retention_select
ON dasher.evidence_records
AS PERMISSIVE
FOR SELECT
TO dasher_retention_definer
USING (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (EXISTS (SELECT 1 FROM dasher.evidence_reference_claims AS target_claim WHERE target_claim.organization_id = evidence_records.organization_id AND target_claim.evidence_id = evidence_records.evidence_id AND target_claim.dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid) OR EXISTS (SELECT 1 FROM dasher.evidence_deletion_finalizers AS target_finalizer JOIN dasher.dashboard_cleanup_coordination AS target_cleanup ON target_cleanup.organization_id = target_finalizer.organization_id WHERE target_finalizer.organization_id = evidence_records.organization_id AND target_finalizer.evidence_id = evidence_records.evidence_id AND target_cleanup.organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid AND target_cleanup.dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid AND target_cleanup.current_step = 'purge_finalizing'::text AND target_cleanup.expected_lifecycle_revision = (current_setting('dasher.retention_expected_lifecycle_revision'::text, true))::bigint AND octet_length(target_cleanup.completion_proof_sha256) = 32 AND target_cleanup.lease_owner IS NULL AND target_cleanup.lease_expires_at IS NULL AND target_finalizer.state = 'deleted'::text AND target_finalizer.proof_sha256 = target_finalizer.expected_claim_set_sha256 AND target_finalizer.bytes_deleted_at IS NOT NULL AND target_finalizer.bytes_deleted_at >= target_finalizer.intent_at AND target_finalizer.expected_claim_set_sha256 = sha256((((uuid_send(evidence_records.organization_id) || uuid_send((current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)) || uuid_send(evidence_records.evidence_id)) || convert_to('evidence|expected_claim_set=empty'::text, 'UTF8'::name))) AND NOT EXISTS (SELECT 1 FROM dasher.evidence_reference_claims AS remaining_claim WHERE remaining_claim.organization_id = evidence_records.organization_id AND remaining_claim.evidence_id = evidence_records.evidence_id)))))
;
CREATE POLICY evidence_records_retention_delete
ON dasher.evidence_records
AS PERMISSIVE
FOR DELETE
TO dasher_retention_definer
USING (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (EXISTS (SELECT 1 FROM dasher.evidence_reference_claims AS target_claim WHERE target_claim.organization_id = evidence_records.organization_id AND target_claim.evidence_id = evidence_records.evidence_id AND target_claim.dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid) OR EXISTS (SELECT 1 FROM dasher.evidence_deletion_finalizers AS target_finalizer JOIN dasher.dashboard_cleanup_coordination AS target_cleanup ON target_cleanup.organization_id = target_finalizer.organization_id WHERE target_finalizer.organization_id = evidence_records.organization_id AND target_finalizer.evidence_id = evidence_records.evidence_id AND target_cleanup.organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid AND target_cleanup.dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid AND target_cleanup.current_step = 'purge_finalizing'::text AND target_cleanup.expected_lifecycle_revision = (current_setting('dasher.retention_expected_lifecycle_revision'::text, true))::bigint AND octet_length(target_cleanup.completion_proof_sha256) = 32 AND target_cleanup.lease_owner IS NULL AND target_cleanup.lease_expires_at IS NULL AND target_finalizer.state = 'deleted'::text AND target_finalizer.proof_sha256 = target_finalizer.expected_claim_set_sha256 AND target_finalizer.bytes_deleted_at IS NOT NULL AND target_finalizer.bytes_deleted_at >= target_finalizer.intent_at AND target_finalizer.expected_claim_set_sha256 = sha256((((uuid_send(evidence_records.organization_id) || uuid_send((current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)) || uuid_send(evidence_records.evidence_id)) || convert_to('evidence|expected_claim_set=empty'::text, 'UTF8'::name))) AND NOT EXISTS (SELECT 1 FROM dasher.evidence_reference_claims AS remaining_claim WHERE remaining_claim.organization_id = evidence_records.organization_id AND remaining_claim.evidence_id = evidence_records.evidence_id)))))
;

CREATE OR REPLACE FUNCTION dasher_private.enforce_retention_mutation()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog
AS $function$
DECLARE
  v_organization_id uuid := current_setting(
    'dasher.retention_target_organization_id', true
  )::uuid;
  v_dashboard_id uuid := current_setting(
    'dasher.retention_target_dashboard_id', true
  )::uuid;
  v_capability text := current_setting('dasher.retention_capability', true);
BEGIN
  IF TG_LEVEL <> 'ROW' OR TG_WHEN <> 'BEFORE'
    OR TG_OP NOT IN ('UPDATE', 'DELETE')
    OR current_user <> 'dasher_retention_definer'::name
    OR current_setting('dasher.retention_phase', true) <> 'authorized'
    OR OLD.organization_id IS DISTINCT FROM v_organization_id
    OR NOT EXISTS (
      SELECT 1 FROM dasher.dashboards AS target
      WHERE target.organization_id = v_organization_id
        AND target.dashboard_id = v_dashboard_id
        AND target.lifecycle_revision = current_setting(
          'dasher.retention_expected_lifecycle_revision', true
        )::bigint
        AND (
          (v_capability = 'release_hold'
            AND target.lifecycle_state <> 'cleaned'
            AND target.purged_at IS NULL)
          OR
          (v_capability = 'purge' AND (
            (target.lifecycle_state = 'purge_eligible'
              AND target.purged_at IS NULL)
            OR
            (target.lifecycle_state = 'cleaned'
              AND target.purged_at IS NOT NULL)
          ))
        )
    )
    OR NOT EXISTS (
      SELECT 1
      FROM dasher.retention_service_principal_allowlist AS authority
      WHERE authority.retention_service_principal_id = current_setting(
          'dasher.retention_principal_id', true
        )::uuid
        AND authority.principal_revision = current_setting(
          'dasher.retention_principal_revision', true
        )::bigint
        AND authority.binding_kind = 'postgres_session_user'
        AND authority.binding_subject = session_user
        AND authority.enabled
        AND authority.scope_organization_id IS NULL
        AND authority.authority_scope = 'platform_operator'
        AND NOT EXISTS (
          SELECT 1
          FROM dasher.retention_service_principal_allowlist AS later
          WHERE later.retention_service_principal_id =
              authority.retention_service_principal_id
            AND later.principal_revision > authority.principal_revision
        )
        AND CASE v_capability
          WHEN 'release_hold' THEN authority.can_release_hold
          WHEN 'purge' THEN authority.can_purge
          ELSE false
        END
    )
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF TG_TABLE_NAME = 'dashboard_legal_holds' THEN
      IF v_capability = 'release_hold'
        AND OLD.dashboard_id IS NOT DISTINCT FROM v_dashboard_id
        AND ROW(
          OLD.organization_id, OLD.dashboard_id, OLD.hold_id,
          OLD.case_matter_reference, OLD.placed_by_principal_id,
          OLD.placed_authority_revision, OLD.placed_actor,
          OLD.placed_reason_sha256, OLD.placed_at,
          OLD.retention_policy_revision
        ) IS NOT DISTINCT FROM ROW(
          NEW.organization_id, NEW.dashboard_id, NEW.hold_id,
          NEW.case_matter_reference, NEW.placed_by_principal_id,
          NEW.placed_authority_revision, NEW.placed_actor,
          NEW.placed_reason_sha256, NEW.placed_at,
          NEW.retention_policy_revision
        )
        AND OLD.released_at IS NULL
        AND OLD.released_by_principal_id IS NULL
        AND OLD.released_authority_revision IS NULL
        AND OLD.released_actor IS NULL
        AND OLD.released_reason_sha256 IS NULL
        AND NEW.released_at IS NOT NULL
        AND NEW.released_by_principal_id IS NOT NULL
        AND NEW.released_authority_revision IS NOT NULL
        AND NEW.released_actor = session_user::text
        AND NEW.released_reason_sha256 IS NOT NULL
      THEN
        RETURN NEW;
      END IF;
    ELSIF TG_TABLE_NAME = 'dashboard_tombstones' THEN
      IF v_capability = 'purge'
        AND EXISTS (
          SELECT 1 FROM dasher.dashboards AS target
          WHERE target.organization_id = v_organization_id
            AND target.dashboard_id = v_dashboard_id
            AND target.tombstone_lineage_id = OLD.tombstone_lineage_id
        )
        AND ROW(
          OLD.organization_id, OLD.tombstone_lineage_id,
          OLD.retention_policy_revision, OLD.access_revoked_at,
          OLD.access_revoked_lifecycle_revision,
          OLD.access_revoked_proof_sha256
        ) IS NOT DISTINCT FROM ROW(
          NEW.organization_id, NEW.tombstone_lineage_id,
          NEW.retention_policy_revision, NEW.access_revoked_at,
          NEW.access_revoked_lifecycle_revision,
          NEW.access_revoked_proof_sha256
        )
        AND OLD.purged_at IS NULL
        AND OLD.purged_lifecycle_revision IS NULL
        AND OLD.purged_proof_sha256 IS NULL
        AND NEW.purged_at IS NOT NULL
        AND NEW.purged_lifecycle_revision IS NOT NULL
        AND NEW.purged_proof_sha256 IS NOT NULL
      THEN
        RETURN NEW;
      END IF;
    ELSIF TG_TABLE_NAME = 'snapshot_deletion_finalizers' THEN
      IF v_capability = 'purge'
        AND OLD.organization_id IS NOT DISTINCT FROM NEW.organization_id
        AND OLD.intent_at IS NOT DISTINCT FROM NEW.intent_at
        AND OLD.expected_claim_set_sha256
          IS NOT DISTINCT FROM NEW.expected_claim_set_sha256
        AND OLD.lease_owner IS NULL AND NEW.lease_owner IS NULL
        AND OLD.lease_expires_at IS NULL AND NEW.lease_expires_at IS NULL
        AND OLD.bytes_deleted_at IS NULL
        AND OLD.snapshot_id IS NOT DISTINCT FROM NEW.snapshot_id
        AND NEW.expected_claim_set_sha256 = sha256(
          uuid_send(v_organization_id) || uuid_send(v_dashboard_id)
          || uuid_send(NEW.snapshot_id)
          || convert_to('snapshot|expected_claim_set=empty', 'UTF8')
        )
        AND NOT EXISTS (
          SELECT 1 FROM dasher.snapshot_reference_claims AS claim
          WHERE claim.organization_id = NEW.organization_id
            AND claim.snapshot_id = NEW.snapshot_id
        )
        AND (
          (OLD.state = 'intent' AND NEW.state = 'eligible'
            AND OLD.proof_sha256 IS NULL
            AND NEW.proof_sha256 = NEW.expected_claim_set_sha256
            AND NEW.bytes_deleted_at IS NULL)
          OR
          (OLD.state = 'eligible' AND NEW.state = 'deleted'
            AND OLD.proof_sha256 = OLD.expected_claim_set_sha256
            AND NEW.proof_sha256 IS NOT DISTINCT FROM OLD.proof_sha256
            AND NEW.bytes_deleted_at IS NOT NULL)
        )
      THEN
        RETURN NEW;
      END IF;
    ELSIF TG_TABLE_NAME = 'evidence_deletion_finalizers' THEN
      IF v_capability = 'purge'
        AND OLD.organization_id IS NOT DISTINCT FROM NEW.organization_id
        AND OLD.intent_at IS NOT DISTINCT FROM NEW.intent_at
        AND OLD.expected_claim_set_sha256
          IS NOT DISTINCT FROM NEW.expected_claim_set_sha256
        AND OLD.lease_owner IS NULL AND NEW.lease_owner IS NULL
        AND OLD.lease_expires_at IS NULL AND NEW.lease_expires_at IS NULL
        AND OLD.bytes_deleted_at IS NULL
        AND OLD.evidence_id IS NOT DISTINCT FROM NEW.evidence_id
        AND NEW.expected_claim_set_sha256 = sha256(
          uuid_send(v_organization_id) || uuid_send(v_dashboard_id)
          || uuid_send(NEW.evidence_id)
          || convert_to('evidence|expected_claim_set=empty', 'UTF8')
        )
        AND NOT EXISTS (
          SELECT 1 FROM dasher.evidence_reference_claims AS claim
          WHERE claim.organization_id = NEW.organization_id
            AND claim.evidence_id = NEW.evidence_id
        )
        AND (
          (OLD.state = 'intent' AND NEW.state = 'eligible'
            AND OLD.proof_sha256 IS NULL
            AND NEW.proof_sha256 = NEW.expected_claim_set_sha256
            AND NEW.bytes_deleted_at IS NULL)
          OR
          (OLD.state = 'eligible' AND NEW.state = 'deleted'
            AND OLD.proof_sha256 = OLD.expected_claim_set_sha256
            AND NEW.proof_sha256 IS NOT DISTINCT FROM OLD.proof_sha256
            AND NEW.bytes_deleted_at IS NOT NULL)
        )
      THEN
        RETURN NEW;
      END IF;
    ELSIF TG_TABLE_NAME = 'artifact_deletion_finalizers' THEN
      IF v_capability = 'purge'
        AND OLD.organization_id IS NOT DISTINCT FROM NEW.organization_id
        AND OLD.intent_at IS NOT DISTINCT FROM NEW.intent_at
        AND OLD.expected_claim_set_sha256
          IS NOT DISTINCT FROM NEW.expected_claim_set_sha256
        AND OLD.lease_owner IS NULL AND NEW.lease_owner IS NULL
        AND OLD.lease_expires_at IS NULL AND NEW.lease_expires_at IS NULL
        AND OLD.bytes_deleted_at IS NULL
        AND OLD.artifact_id IS NOT DISTINCT FROM NEW.artifact_id
        AND NEW.expected_claim_set_sha256 = sha256(
          uuid_send(v_organization_id) || uuid_send(v_dashboard_id)
          || uuid_send(NEW.artifact_id)
          || convert_to('artifact|expected_claim_set=empty', 'UTF8')
        )
        AND NOT EXISTS (
          SELECT 1 FROM dasher.artifact_reference_claims AS claim
          WHERE claim.organization_id = NEW.organization_id
            AND claim.artifact_id = NEW.artifact_id
        )
        AND (
          (OLD.state = 'intent' AND NEW.state = 'eligible'
            AND OLD.proof_sha256 IS NULL
            AND NEW.proof_sha256 = NEW.expected_claim_set_sha256
            AND NEW.bytes_deleted_at IS NULL)
          OR
          (OLD.state = 'eligible' AND NEW.state = 'deleted'
            AND OLD.proof_sha256 = OLD.expected_claim_set_sha256
            AND NEW.proof_sha256 IS NOT DISTINCT FROM OLD.proof_sha256
            AND NEW.bytes_deleted_at IS NOT NULL)
        )
      THEN
        RETURN NEW;
      END IF;
    END IF;

    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  ELSIF TG_OP = 'DELETE' THEN
    IF TG_TABLE_NAME = 'snapshot_reference_claims' THEN
      IF v_capability = 'release_hold'
        AND OLD.dashboard_id IS NOT DISTINCT FROM v_dashboard_id
        AND OLD.claim_kind = 'retention_only'
        AND OLD.hold_id IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM dasher.dashboard_legal_holds AS hold
          WHERE hold.organization_id = OLD.organization_id
            AND hold.dashboard_id = OLD.dashboard_id
            AND hold.hold_id = OLD.hold_id
            AND hold.released_at IS NOT NULL
        )
      THEN
        RETURN OLD;
      ELSIF v_capability = 'purge'
        AND OLD.dashboard_id IS NOT DISTINCT FROM v_dashboard_id
        AND OLD.claim_kind = 'access_bearing'
        AND OLD.hold_id IS NULL
      THEN
        RETURN OLD;
      END IF;
    ELSIF TG_TABLE_NAME = 'evidence_reference_claims' THEN
      IF v_capability = 'release_hold'
        AND OLD.dashboard_id IS NOT DISTINCT FROM v_dashboard_id
        AND OLD.claim_kind = 'retention_only'
        AND OLD.hold_id IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM dasher.dashboard_legal_holds AS hold
          WHERE hold.organization_id = OLD.organization_id
            AND hold.dashboard_id = OLD.dashboard_id
            AND hold.hold_id = OLD.hold_id
            AND hold.released_at IS NOT NULL
        )
      THEN
        RETURN OLD;
      ELSIF v_capability = 'purge'
        AND OLD.dashboard_id IS NOT DISTINCT FROM v_dashboard_id
        AND OLD.claim_kind = 'access_bearing'
        AND OLD.hold_id IS NULL
      THEN
        RETURN OLD;
      END IF;
    ELSIF TG_TABLE_NAME = 'artifact_reference_claims' THEN
      IF v_capability = 'release_hold'
        AND OLD.dashboard_id IS NOT DISTINCT FROM v_dashboard_id
        AND OLD.claim_kind = 'retention_only'
        AND OLD.hold_id IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM dasher.dashboard_legal_holds AS hold
          WHERE hold.organization_id = OLD.organization_id
            AND hold.dashboard_id = OLD.dashboard_id
            AND hold.hold_id = OLD.hold_id
            AND hold.released_at IS NOT NULL
        )
      THEN
        RETURN OLD;
      ELSIF v_capability = 'purge'
        AND OLD.dashboard_id IS NOT DISTINCT FROM v_dashboard_id
        AND OLD.claim_kind = 'access_bearing'
        AND OLD.hold_id IS NULL
      THEN
        RETURN OLD;
      END IF;
    ELSIF TG_TABLE_NAME = 'dashboard_versions' THEN
      IF v_capability = 'purge'
        AND OLD.dashboard_id IS NOT DISTINCT FROM v_dashboard_id
      THEN
        RETURN OLD;
      END IF;
    ELSIF TG_TABLE_NAME = 'dashboard_version_snapshots' THEN
      IF v_capability = 'purge'
        AND OLD.dashboard_id IS NOT DISTINCT FROM v_dashboard_id
      THEN
        RETURN OLD;
      END IF;
    ELSIF TG_TABLE_NAME = 'dashboard_version_evidence' THEN
      IF v_capability = 'purge'
        AND OLD.dashboard_id IS NOT DISTINCT FROM v_dashboard_id
      THEN
        RETURN OLD;
      END IF;
    ELSIF TG_TABLE_NAME = 'dashboard_restore_lineage' THEN
      IF v_capability = 'purge'
        AND OLD.dashboard_id IS NOT DISTINCT FROM v_dashboard_id
      THEN
        RETURN OLD;
      END IF;
    ELSIF TG_TABLE_NAME = 'source_snapshots' THEN
      IF v_capability = 'purge'
        AND NOT EXISTS (
          SELECT 1 FROM dasher.snapshot_reference_claims AS claim
          WHERE claim.organization_id = OLD.organization_id
            AND claim.snapshot_id = OLD.snapshot_id
        )
        AND EXISTS (
          SELECT 1 FROM dasher.snapshot_deletion_finalizers AS finalizer
          WHERE finalizer.organization_id = OLD.organization_id
            AND finalizer.snapshot_id = OLD.snapshot_id
            AND finalizer.state = 'deleted'
            AND finalizer.proof_sha256 IS NOT NULL
            AND finalizer.bytes_deleted_at IS NOT NULL
            AND finalizer.expected_claim_set_sha256 = sha256(
              uuid_send(v_organization_id) || uuid_send(v_dashboard_id)
              || uuid_send(finalizer.snapshot_id)
              || convert_to('snapshot|expected_claim_set=empty', 'UTF8')
            )
        )
      THEN
        RETURN OLD;
      END IF;
    ELSIF TG_TABLE_NAME = 'evidence_records' THEN
      IF v_capability = 'purge'
        AND NOT EXISTS (
          SELECT 1 FROM dasher.evidence_reference_claims AS claim
          WHERE claim.organization_id = OLD.organization_id
            AND claim.evidence_id = OLD.evidence_id
        )
        AND EXISTS (
          SELECT 1 FROM dasher.evidence_deletion_finalizers AS finalizer
          WHERE finalizer.organization_id = OLD.organization_id
            AND finalizer.evidence_id = OLD.evidence_id
            AND finalizer.state = 'deleted'
            AND finalizer.proof_sha256 IS NOT NULL
            AND finalizer.bytes_deleted_at IS NOT NULL
            AND finalizer.expected_claim_set_sha256 = sha256(
              uuid_send(v_organization_id) || uuid_send(v_dashboard_id)
              || uuid_send(finalizer.evidence_id)
              || convert_to('evidence|expected_claim_set=empty', 'UTF8')
            )
        )
      THEN
        RETURN OLD;
      END IF;
    ELSIF TG_TABLE_NAME = 'dashboard_artifacts' THEN
      IF v_capability = 'purge'
        AND (
          (OLD.ownership_class = 'dashboard_owned'
            AND OLD.dashboard_id IS NOT DISTINCT FROM v_dashboard_id)
          OR OLD.ownership_class = 'shared'
        )
        AND NOT EXISTS (
          SELECT 1 FROM dasher.artifact_reference_claims AS claim
          WHERE claim.organization_id = OLD.organization_id
            AND claim.artifact_id = OLD.artifact_id
        )
        AND EXISTS (
          SELECT 1 FROM dasher.artifact_deletion_finalizers AS finalizer
          WHERE finalizer.organization_id = OLD.organization_id
            AND finalizer.artifact_id = OLD.artifact_id
            AND finalizer.state = 'deleted'
            AND finalizer.proof_sha256 IS NOT NULL
            AND finalizer.bytes_deleted_at IS NOT NULL
            AND finalizer.expected_claim_set_sha256 = sha256(
              uuid_send(v_organization_id) || uuid_send(v_dashboard_id)
              || uuid_send(finalizer.artifact_id)
              || convert_to('artifact|expected_claim_set=empty', 'UTF8')
            )
        )
      THEN
        RETURN OLD;
      END IF;
    END IF;

    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;

  RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
END
$function$;
