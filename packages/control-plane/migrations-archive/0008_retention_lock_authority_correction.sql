-- Dasher retention lock-authority, cleanup-claim conflict-target, agent-run
-- drain reachability, cleanup-attempt visibility, drain-proof audit-read,
-- audit-event-id collision normalization and backup-deletion-ledger vocabulary
-- correction.
--
-- Seven independent frozen defects are repaired here. Part 1 restores the
-- retention definer's row-mark authority. Part 2 re-issues one frozen 0007
-- function whose ON CONFLICT inference list could not name a table column.
-- Part 3 grants the retention definer the one schema privilege frozen 0007
-- omitted, and re-issues the agent-run drain so its legal-hold gate agrees
-- with the purge gate on what "held" means. Part 4 re-issues the frozen 0003
-- retention SELECT policy on dasher.dashboard_cleanup_attempts, and the lock
-- policy Part 1 mirrors onto it, so the capability the cleanup claim actually
-- runs under can see the attempt it must read. Part 5 grants the retention
-- definer a column-scoped SELECT over the eight dasher.audit_events columns
-- its own drain-proof recomputation reads, and issues the single SELECT policy
-- that makes that grant safe. Parts 2 and 3
-- use the same CREATE OR REPLACE body-correction convention 0004 and 0006
-- already use, Part 4 uses the DROP-then-CREATE policy-replacement convention
-- of 0006, and Part 5 adds a policy where none existed. Nothing else in the
-- frozen series is touched.
--
-- The sixth defect is one repair spread over six bodies.
-- dasher.audit_events.audit_event_id is a global primary key, and six frozen
-- 0007 entry points write it from a caller-supplied uuid. Five of them - the
-- cleanup claim, the agent-run drain, the age-out,
-- dasher_api.request_agent_run and dasher_retention_api.purge_dashboard -
-- carry no probe at all that could observe that uuid being spent in another
-- scope. The sixth, dasher_api.cancel_agent_run, does carry one - a global
-- uniqueness probe over dasher.audit_events keyed on the operation id alone
-- (0007:19860) - but it is insufficient for the two independent reasons set
-- out below and documented in full in Part 10: its advisory lock is namespaced
-- to the cancel operation, and its probe-then-INSERT ordering only serializes
-- under READ COMMITTED. So on all six a cross-scope duplicate reaches the
-- audit INSERT and PostgreSQL raises a bare 23505 carrying the constraint name
-- - the one outcome this series does not permit an entry point to emit for a
-- duplicate non-idempotent operation, which must normalize to P1002 /
-- dasher_conflict without exposing SQL, constraints or existence detail.
-- Part 6 normalizes the age-out;
-- Part 7 normalizes dasher_api.request_agent_run; Part 8 normalizes
-- dasher_retention_api.purge_dashboard; Part 10 normalizes
-- dasher_api.cancel_agent_run; and the same wrapper is carried in the
-- bodies Parts 2 and 3 already re-issue, for
-- dasher_retention_api.claim_dashboard_cleanup and
-- dasher_retention_api.drain_dashboard_agent_runs, because each of those
-- routines is re-issued exactly once here and the normalization belongs to the
-- body that actually gets installed rather than to frozen bytes that were
-- already replaced. Each wrapper encloses one INSERT statement and nothing
-- else, and each Part header enumerates the lines it adds. The sixth site,
-- dasher_api.cancel_agent_run (0007:20291), is not exempt. Its
-- pg_advisory_xact_lock (0007:19838) is keyed on the cancel-operation namespace
-- alone, so it serializes cancel against cancel and not against the other five
-- entry points that spend the same global key; and its probe-then-INSERT
-- ordering only serializes under READ COMMITTED, which this series pins on the
-- retention path and never on dasher_api. Part 10 wraps it for both reasons and
-- keeps the lock and the probe as the earlier, cheaper refusal.
--
-- The seventh defect is the backup-deletion-ledger vocabulary, corrected by
-- Part 9: the frozen age-out requires a ledger row whose event_kind is
-- 'backup.deleted', and the frozen 0003 CHECK admits only 'access_revoked' and
-- 'purged', so the entry point could never run. Part 9 widens that one
-- constraint's admitted value set by exactly that one value and changes
-- nothing else.

-- Part 1 - retention row-mark authority.

-- Frozen 0007 row-marks every relation the retention definer must serialize on
-- with FOR UPDATE, but the definer only ever held SELECT authority over the
-- relations below. A row mark needs UPDATE authority on at least one column and
-- an UPDATE USING policy that admits the row, so each mark failed either with
-- "permission denied" or by silently matching nothing. This correction restores
-- exactly the row-mark authority and nothing else:
--
--   * UPDATE is granted only on the primary-key columns that already identify
--     the row, mirroring the column-scoped identity grants 0007 issues to
--     dasher_run_definer. No content, capability, predicate, or provenance
--     column becomes update-granted anywhere.
--   * Each lock policy repeats its relation's retention SELECT predicate
--     verbatim, so the set of lockable rows equals the set of already-visible
--     rows, and carries WITH CHECK (false) so no UPDATE can ever produce a row.
--     For dasher.dashboard_cleanup_attempts that predicate is the one Part 4
--     re-issues below, not the frozen 0003 spelling it replaces; every other
--     relation's is frozen and unchanged.

GRANT UPDATE (
  organization_id, dashboard_id, run_id, candidate_id
) ON TABLE dasher.agent_candidate_payloads
  TO dasher_retention_definer;
CREATE POLICY agent_candidate_payloads_retention_definer_lock
ON dasher.agent_candidate_payloads
AS PERMISSIVE
FOR UPDATE
TO dasher_retention_definer
USING (dasher_private.retention_policy_allows_v1(organization_id, dashboard_id))
WITH CHECK (false);

GRANT UPDATE (
  organization_id, dashboard_id, run_id, candidate_id
) ON TABLE dasher.agent_candidates
  TO dasher_retention_definer;
CREATE POLICY agent_candidates_retention_definer_lock
ON dasher.agent_candidates
AS PERMISSIVE
FOR UPDATE
TO dasher_retention_definer
USING (dasher_private.retention_policy_allows_v1(organization_id, dashboard_id))
WITH CHECK (false);

GRANT UPDATE (
  organization_id, dashboard_id, run_id, result_sequence
) ON TABLE dasher.agent_recorded_results
  TO dasher_retention_definer;
CREATE POLICY agent_recorded_results_retention_definer_lock
ON dasher.agent_recorded_results
AS PERMISSIVE
FOR UPDATE
TO dasher_retention_definer
USING (dasher_private.retention_policy_allows_v1(organization_id, dashboard_id))
WITH CHECK (false);

GRANT UPDATE (
  organization_id, dashboard_id, run_id, attempt_id, payload_kind,
  payload_id
) ON TABLE dasher.agent_run_attempt_payloads
  TO dasher_retention_definer;
CREATE POLICY agent_run_attempt_payloads_retention_definer_lock
ON dasher.agent_run_attempt_payloads
AS PERMISSIVE
FOR UPDATE
TO dasher_retention_definer
USING (dasher_private.retention_policy_allows_v1(organization_id, dashboard_id))
WITH CHECK (false);

GRANT UPDATE (
  organization_id, dashboard_id, run_id, meter_id
) ON TABLE dasher.agent_run_calculation_meters
  TO dasher_retention_definer;
CREATE POLICY agent_run_calculation_meters_retention_definer_lock
ON dasher.agent_run_calculation_meters
AS PERMISSIVE
FOR UPDATE
TO dasher_retention_definer
USING (dasher_private.retention_policy_allows_v1(organization_id, dashboard_id))
WITH CHECK (false);

GRANT UPDATE (
  organization_id, dashboard_id, checkpoint_payload_id
) ON TABLE dasher.agent_run_checkpoint_payloads
  TO dasher_retention_definer;
CREATE POLICY agent_run_checkpoint_payloads_retention_definer_lock
ON dasher.agent_run_checkpoint_payloads
AS PERMISSIVE
FOR UPDATE
TO dasher_retention_definer
USING (dasher_private.retention_policy_allows_v1(organization_id, dashboard_id))
WITH CHECK (false);

GRANT UPDATE (
  organization_id, dashboard_id, request_payload_id
) ON TABLE dasher.agent_run_request_payloads
  TO dasher_retention_definer;
CREATE POLICY agent_run_request_payloads_retention_definer_lock
ON dasher.agent_run_request_payloads
AS PERMISSIVE
FOR UPDATE
TO dasher_retention_definer
USING (dasher_private.retention_policy_allows_v1(organization_id, dashboard_id))
WITH CHECK (false);

GRANT UPDATE (
  organization_id, dashboard_id, run_id, candidate_id
) ON TABLE dasher.agent_validation_findings
  TO dasher_retention_definer;
CREATE POLICY agent_validation_findings_retention_definer_lock
ON dasher.agent_validation_findings
AS PERMISSIVE
FOR UPDATE
TO dasher_retention_definer
USING (dasher_private.retention_policy_allows_v1(organization_id, dashboard_id))
WITH CHECK (false);

GRANT UPDATE (
  organization_id, ledger_sequence
) ON TABLE dasher.backup_deletion_ledger
  TO dasher_retention_definer;
CREATE POLICY backup_deletion_ledger_retention_lock
ON dasher.backup_deletion_ledger
AS PERMISSIVE
FOR UPDATE
TO dasher_retention_definer
USING (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['materialize_expiry'::text, 'purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND EXISTS (SELECT 1 FROM dasher.dashboards AS target WHERE target.organization_id = backup_deletion_ledger.organization_id AND target.dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid AND target.tombstone_lineage_id = backup_deletion_ledger.tombstone_lineage_id)))
WITH CHECK (false);

GRANT UPDATE (
  organization_id, dashboard_id, run_id, brief_id
) ON TABLE dasher.briefs
  TO dasher_retention_definer;
CREATE POLICY briefs_retention_definer_lock
ON dasher.briefs
AS PERMISSIVE
FOR UPDATE
TO dasher_retention_definer
USING (dasher_private.retention_policy_allows_v1(organization_id, dashboard_id))
WITH CHECK (false);

GRANT UPDATE (
  organization_id, dashboard_id, run_id, graph_id
) ON TABLE dasher.calculation_graphs
  TO dasher_retention_definer;
CREATE POLICY calculation_graphs_retention_definer_lock
ON dasher.calculation_graphs
AS PERMISSIVE
FOR UPDATE
TO dasher_retention_definer
USING (dasher_private.retention_policy_allows_v1(organization_id, dashboard_id))
WITH CHECK (false);

GRANT UPDATE (
  organization_id, dashboard_id, run_id, result_id
) ON TABLE dasher.calculation_results
  TO dasher_retention_definer;
CREATE POLICY calculation_results_retention_definer_lock
ON dasher.calculation_results
AS PERMISSIVE
FOR UPDATE
TO dasher_retention_definer
USING (dasher_private.retention_policy_allows_v1(organization_id, dashboard_id))
WITH CHECK (false);

GRANT UPDATE (
  organization_id, dashboard_id, run_id, bundle_id
) ON TABLE dasher.candidate_comparison_bundles
  TO dasher_retention_definer;
CREATE POLICY candidate_comparison_bundles_retention_definer_lock
ON dasher.candidate_comparison_bundles
AS PERMISSIVE
FOR UPDATE
TO dasher_retention_definer
USING (dasher_private.retention_policy_allows_v1(organization_id, dashboard_id))
WITH CHECK (false);

GRANT UPDATE (
  organization_id, dashboard_id, run_id, candidate_id
) ON TABLE dasher.candidate_evidence_manifests
  TO dasher_retention_definer;
CREATE POLICY candidate_evidence_manifests_retention_definer_lock
ON dasher.candidate_evidence_manifests
AS PERMISSIVE
FOR UPDATE
TO dasher_retention_definer
USING (dasher_private.retention_policy_allows_v1(organization_id, dashboard_id))
WITH CHECK (false);

GRANT UPDATE (
  organization_id, dashboard_id, run_id, candidate_id, claim_id, bundle_id,
  evidence_id, relation
) ON TABLE dasher.claim_evidence
  TO dasher_retention_definer;
CREATE POLICY claim_evidence_retention_definer_lock
ON dasher.claim_evidence
AS PERMISSIVE
FOR UPDATE
TO dasher_retention_definer
USING (dasher_private.retention_policy_allows_v1(organization_id, dashboard_id))
WITH CHECK (false);

GRANT UPDATE (
  organization_id, dashboard_id, run_id, candidate_id, claim_id
) ON TABLE dasher.claims
  TO dasher_retention_definer;
CREATE POLICY claims_retention_definer_lock
ON dasher.claims
AS PERMISSIVE
FOR UPDATE
TO dasher_retention_definer
USING (dasher_private.retention_policy_allows_v1(organization_id, dashboard_id))
WITH CHECK (false);

GRANT UPDATE (
  organization_id, dashboard_id, proof_id
) ON TABLE dasher.dashboard_agent_drain_proof_consumptions
  TO dasher_retention_definer;
CREATE POLICY dashboard_agent_drain_proof_consumptions_retention_definer_lock
ON dasher.dashboard_agent_drain_proof_consumptions
AS PERMISSIVE
FOR UPDATE
TO dasher_retention_definer
USING (dasher_private.retention_policy_allows_v1(organization_id, dashboard_id))
WITH CHECK (false);

GRANT UPDATE (
  organization_id, dashboard_id, proof_id
) ON TABLE dasher.dashboard_agent_drain_proofs
  TO dasher_retention_definer;
CREATE POLICY dashboard_agent_drain_proofs_retention_definer_lock
ON dasher.dashboard_agent_drain_proofs
AS PERMISSIVE
FOR UPDATE
TO dasher_retention_definer
USING (dasher_private.retention_policy_allows_v1(organization_id, dashboard_id))
WITH CHECK (false);

GRANT UPDATE (
  organization_id, dashboard_id, age_out_operation_id
) ON TABLE dasher.dashboard_agent_run_age_out_proofs
  TO dasher_retention_definer;
CREATE POLICY dashboard_agent_run_age_out_proofs_retention_definer_lock
ON dasher.dashboard_agent_run_age_out_proofs
AS PERMISSIVE
FOR UPDATE
TO dasher_retention_definer
USING (dasher_private.retention_policy_allows_v1(organization_id, dashboard_id))
WITH CHECK (false);

GRANT UPDATE (
  organization_id, dashboard_id, cleanup_attempt_id
) ON TABLE dasher.dashboard_cleanup_attempts
  TO dasher_retention_definer;
CREATE POLICY dashboard_cleanup_attempts_retention_lock
ON dasher.dashboard_cleanup_attempts
AS PERMISSIVE
FOR UPDATE
TO dasher_retention_definer
USING (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['claim_cleanup'::text, 'record_attempt'::text, 'purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)))
WITH CHECK (false);

GRANT UPDATE (
  organization_id, dashboard_id, catalog_snapshot_id, field_id
) ON TABLE dasher.field_catalog_entries
  TO dasher_retention_definer;
CREATE POLICY field_catalog_entries_retention_definer_lock
ON dasher.field_catalog_entries
AS PERMISSIVE
FOR UPDATE
TO dasher_retention_definer
USING (dasher_private.retention_policy_allows_v1(organization_id, dashboard_id))
WITH CHECK (false);

GRANT UPDATE (
  organization_id, dashboard_id, catalog_snapshot_id
) ON TABLE dasher.field_catalog_snapshots
  TO dasher_retention_definer;
CREATE POLICY field_catalog_snapshots_retention_definer_lock
ON dasher.field_catalog_snapshots
AS PERMISSIVE
FOR UPDATE
TO dasher_retention_definer
USING (dasher_private.retention_policy_allows_v1(organization_id, dashboard_id))
WITH CHECK (false);

GRANT UPDATE (
  organization_id, dashboard_id, contract_id, contract_version
) ON TABLE dasher.metric_contract_versions
  TO dasher_retention_definer;
CREATE POLICY metric_contract_versions_retention_definer_lock
ON dasher.metric_contract_versions
AS PERMISSIVE
FOR UPDATE
TO dasher_retention_definer
USING (dasher_private.retention_policy_allows_v1(organization_id, dashboard_id))
WITH CHECK (false);

GRANT UPDATE (
  retention_service_principal_id, principal_revision
) ON TABLE dasher.retention_service_principal_allowlist
  TO dasher_retention_definer;
CREATE POLICY retention_service_principal_self_binding_lock
ON dasher.retention_service_principal_allowlist
AS PERMISSIVE
FOR UPDATE
TO dasher_retention_definer
USING (((CURRENT_USER = 'dasher_retention_definer'::name) AND (binding_kind = 'postgres_session_user'::text) AND (binding_subject = SESSION_USER)))
WITH CHECK (false);

GRANT UPDATE (
  organization_id, dashboard_id, run_id
) ON TABLE dasher.run_abstentions
  TO dasher_retention_definer;
CREATE POLICY run_abstentions_retention_definer_lock
ON dasher.run_abstentions
AS PERMISSIVE
FOR UPDATE
TO dasher_retention_definer
USING (dasher_private.retention_policy_allows_v1(organization_id, dashboard_id))
WITH CHECK (false);

-- Part 2 - dasher_retention_api.claim_dashboard_cleanup conflict target and
-- audit-event-id collision normalization.
--
-- Two independent corrections land in this one re-issued body, because this
-- function is re-issued exactly once in this migration and the second
-- correction belongs to the body that actually gets installed, not to the
-- frozen 0007 bytes the first correction already replaced. Re-issuing the same
-- routine a second time later in the same file would leave two full copies of
-- it here of which only the last could ever run, so both deltas are carried
-- here and both are enumerated below. The diff against frozen 0007 is exactly
-- one changed line plus the four-line wrapper described under (2).
--
-- (1) Conflict target.
--
-- The frozen 0007 definition declares a named `dashboard_id` parameter and
-- opens its body with `#variable_conflict use_variable`. Its coordination
-- upsert then spelled the conflict target as an inference list over
-- (organization_id, dashboard_id), so plpgsql resolved `dashboard_id` there to
-- the parameter instead of the target column and PostgreSQL reported "there
-- is no unique or exclusion constraint matching the ON CONFLICT
-- specification" for every caller. The 0003 ancestor of this function spelled
-- its parameters positionally and was never affected.
--
-- The re-issued body below is byte-identical to the frozen 0007 definition
-- apart from a single line: the inference list becomes the name of the very
-- same unique index it was always meant to infer,
-- dashboard_cleanup_coordination_pkey on (organization_id, dashboard_id),
-- which no plpgsql variable can shadow. Signature, SECURITY DEFINER, search
-- path, volatility, the conflict directive, every declaration, and every
-- statement are preserved, so the lease guard in the DO UPDATE ... WHERE
-- clause and its NOT FOUND conflict path keep their frozen semantics.
--
-- The two sibling functions that also carry `#variable_conflict use_variable`
-- need no correction: record_dashboard_cleanup_attempt has no ON CONFLICT
-- clause at all, and purge_dashboard infers on (organization_id,
-- snapshot_id), (organization_id, evidence_id) and (organization_id,
-- artifact_id), none of which names one of its parameters or declarations.
--
-- (2) Audit-event-id collision normalization.
--
-- dasher.audit_events.audit_event_id is a global primary key, and this
-- function writes it from a caller-supplied parameter,
-- lifecycle_event_and_audit_id. Every guard the function carries is scoped -
-- to this organization, this dashboard, this lifecycle revision - so none of
-- them can observe that the id was already spent by an audit row belonging to
-- some other dashboard, target type or organization. The frozen body therefore
-- reaches its audit INSERT and lets PostgreSQL raise a bare 23505 carrying the
-- constraint name, which is the one outcome this series does not permit an
-- entry point to emit for a duplicate non-idempotent operation: it must
-- normalize to P1002 / dasher_conflict without exposing SQL, constraints or
-- existence detail. The audit INSERT below is wrapped in the same block Part 6
-- uses on the age-out, whose only handler turns unique_violation into that
-- same P1002 every other conflict path in this function already raises.
--
-- The wrapper normalizes an error; it does not widen a read, and it does not
-- change what is written. The handler learns only that the INSERT it just
-- issued violated a unique constraint - which the caller was going to be told
-- regardless - and it reports strictly less than PostgreSQL would have. It
-- re-raises rather than swallowing, so its block's subtransaction unwinds the
-- audit INSERT and the propagating exception unwinds everything the call had
-- already done, leaving the dashboard exactly as it was before the call. Only
-- the single INSERT statement is inside the block: every FOR UPDATE row mark,
-- every probe and every other write stays in the outer transaction where the
-- frozen body put it.

CREATE OR REPLACE FUNCTION dasher_retention_api.claim_dashboard_cleanup(
  dashboard_id uuid,
  expected_lifecycle_revision bigint,
  expected_transition_proof_sha256 bytea,
  lease_duration interval,
  lifecycle_event_and_audit_id uuid,
  deployment_revision text,
  target_organization_id uuid
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
#variable_conflict use_variable
DECLARE
  v_organization_id uuid;
  v_authority_revision bigint;
  v_dashboard dasher.dashboards%ROWTYPE;
  v_coordination dasher.dashboard_cleanup_coordination%ROWTYPE;
  v_proof dasher.dashboard_agent_drain_proofs%ROWTYPE;
  v_attempt dasher.dashboard_cleanup_attempts%ROWTYPE;
  v_existing_consumption dasher.dashboard_agent_drain_proof_consumptions%ROWTYPE;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_expiry timestamptz;
  v_target_state text;
  v_step text;
  v_event_kind text;
  v_audit_action text;
  v_consumption_sha bytea;
  v_new_revision bigint;
BEGIN
  IF current_user <> 'dasher_retention_definer'::name
    OR dashboard_id IS NULL OR expected_lifecycle_revision < 0
    OR target_organization_id IS NULL
    OR (expected_transition_proof_sha256 IS NOT NULL
      AND pg_catalog.octet_length(expected_transition_proof_sha256) <> 32)
    OR lease_duration IS NULL OR lease_duration <= interval '0 seconds'
    OR lease_duration > interval '15 minutes'
    OR lifecycle_event_and_audit_id IS NULL OR deployment_revision IS NULL
    OR pg_catalog.btrim(deployment_revision) <> deployment_revision
    OR pg_catalog.char_length(deployment_revision) NOT BETWEEN 1 AND 64
    OR deployment_revision ~ '[[:cntrl:]]'
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  PERFORM dasher_retention_api.initialize_operator_context(
    dashboard_id, 'claim_cleanup', lifecycle_event_and_audit_id,
    deployment_revision, target_organization_id
  );
  v_organization_id := current_setting(
    'dasher.retention_target_organization_id', true
  )::uuid;
  v_authority_revision := current_setting(
    'dasher.retention_principal_revision', true
  )::bigint;
  SELECT coordination.* INTO v_coordination
  FROM dasher.dashboard_cleanup_coordination AS coordination
  WHERE coordination.organization_id = v_organization_id
    AND coordination.dashboard_id = dashboard_id
  FOR UPDATE;
  PERFORM 1 FROM dasher.retention_service_principal_allowlist AS authority
  WHERE authority.retention_service_principal_id = current_setting(
      'dasher.retention_principal_id', true
    )::uuid
    AND authority.principal_revision = v_authority_revision
    AND authority.binding_kind = 'postgres_session_user'
    AND authority.binding_subject = session_user AND authority.enabled
    AND authority.authority_scope = 'platform_operator'
    AND authority.scope_organization_id IS NULL
    AND authority.can_claim_cleanup
    AND NOT EXISTS (
      SELECT 1 FROM dasher.retention_service_principal_allowlist AS later
      WHERE later.retention_service_principal_id =
        authority.retention_service_principal_id
        AND later.principal_revision > authority.principal_revision
    )
  FOR UPDATE OF authority;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  SELECT consumed.* INTO v_existing_consumption
  FROM dasher.dashboard_agent_drain_proof_consumptions AS consumed
  WHERE consumed.organization_id = v_organization_id
    AND consumed.dashboard_id = dashboard_id
    AND consumed.claim_event_and_audit_id = lifecycle_event_and_audit_id
  FOR UPDATE;
  IF FOUND THEN
    IF expected_transition_proof_sha256 IS NULL
      OR v_existing_consumption.lifecycle_revision <>
        expected_lifecycle_revision
      OR v_existing_consumption.drain_proof_sha256 <>
        expected_transition_proof_sha256
      OR v_existing_consumption.retention_principal_id <> current_setting(
        'dasher.retention_principal_id', true
      )::uuid
      OR v_existing_consumption.retention_principal_revision <>
        v_authority_revision
      OR v_existing_consumption.consumption_sha256 <>
        dasher_private.recompute_drain_consumption_v1(
          v_organization_id, dashboard_id
        )
    THEN
      RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
    END IF;
    RETURN;
  END IF;
  PERFORM 1 FROM dasher.dashboard_lifecycle_policies AS policy
  WHERE policy.organization_id = v_organization_id
  ORDER BY policy.policy_revision DESC LIMIT 1 FOR UPDATE OF policy;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  SELECT dashboard.* INTO STRICT v_dashboard
  FROM dasher.dashboards AS dashboard
  WHERE dashboard.organization_id = v_organization_id
    AND dashboard.dashboard_id = dashboard_id
    AND dashboard.lifecycle_revision = expected_lifecycle_revision
    AND dashboard.lifecycle_state IN (
      'access_revoked','quarantined','purge_eligible'
    )
    AND dashboard.access_revoked_at IS NOT NULL
    AND dashboard.purge_after IS NOT NULL AND dashboard.purged_at IS NULL
  FOR UPDATE;
  PERFORM 1 FROM dasher.dashboard_legal_holds AS hold
  WHERE hold.organization_id = v_organization_id
    AND hold.dashboard_id = dashboard_id
  ORDER BY pg_catalog.uuid_send(hold.hold_id) FOR UPDATE OF hold;
  IF expected_transition_proof_sha256 IS NOT NULL THEN
    SELECT proof.* INTO STRICT v_proof
    FROM dasher.dashboard_agent_drain_proofs AS proof
    WHERE proof.organization_id = v_organization_id
      AND proof.dashboard_id = dashboard_id
      AND proof.lifecycle_revision = expected_lifecycle_revision
    ORDER BY proof.generated_at DESC, pg_catalog.uuid_send(proof.proof_id) DESC
    LIMIT 1 FOR UPDATE;
    SELECT attempt.* INTO STRICT v_attempt
    FROM dasher.dashboard_cleanup_attempts AS attempt
    WHERE attempt.organization_id = v_organization_id
      AND attempt.dashboard_id = dashboard_id
      AND attempt.cleanup_attempt_id = v_proof.cleanup_attempt_id
      AND attempt.result IN ('succeeded','already_complete')
    FOR UPDATE;
    IF v_proof.drain_proof_sha256 <> expected_transition_proof_sha256
      OR v_proof.drain_proof_sha256 <>
        dasher_private.recompute_drain_proof_v1(
          v_organization_id, dashboard_id
        )
      OR v_proof.event_range_sha256 <>
        dasher_private.recompute_drain_event_range_v1(
          v_organization_id, dashboard_id
        )
      OR v_proof.remaining_nonterminal_run_count <> 0
      OR v_proof.remaining_claimed_run_count <> 0
      OR v_attempt.proof_sha256 <>
        dasher_private.recompute_cleanup_completion_proof_v1(
          v_organization_id, dashboard_id
        )
      OR EXISTS (
        SELECT 1 FROM dasher.dashboard_agent_drain_proof_consumptions AS consumed
        WHERE consumed.organization_id = v_organization_id
          AND consumed.dashboard_id = dashboard_id
          AND consumed.proof_id = v_proof.proof_id
      )
      OR EXISTS (
        SELECT 1 FROM dasher.agent_runs AS run
        WHERE run.organization_id = v_organization_id
          AND run.dashboard_id = dashboard_id
          AND (run.state NOT IN ('rejected','cancelled','expired','failed')
            OR run.lease_token_sha256 IS NOT NULL
            OR run.lease_owner_principal_id IS NOT NULL
            OR run.lease_owner_principal_revision IS NOT NULL
            OR run.lease_expires_at IS NOT NULL)
      )
    THEN
      RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
    END IF;
  END IF;
  IF v_dashboard.lifecycle_state = 'access_revoked'
    AND expected_transition_proof_sha256 IS NOT NULL
  THEN
    v_target_state := 'quarantined';
    v_event_kind := 'cleanup_started';
    v_audit_action := 'dashboard.cleanup_started';
  ELSIF v_dashboard.lifecycle_state = 'quarantined'
    AND expected_transition_proof_sha256 IS NOT NULL
    AND v_now >= v_dashboard.purge_after
    AND NOT EXISTS (
      SELECT 1 FROM dasher.dashboard_legal_holds AS hold
      WHERE hold.organization_id = v_organization_id
        AND hold.dashboard_id = dashboard_id AND hold.released_at IS NULL
    )
  THEN
    v_target_state := 'purge_eligible';
    v_event_kind := 'purge_eligible';
    v_audit_action := 'dashboard.purge_eligible';
  ELSE
    v_target_state := v_dashboard.lifecycle_state;
  END IF;
  v_new_revision := expected_lifecycle_revision
    + CASE WHEN v_target_state <> v_dashboard.lifecycle_state THEN 1 ELSE 0 END;
  v_step := CASE v_target_state
    WHEN 'access_revoked' THEN 'drain_and_cancel'
    WHEN 'quarantined' THEN 'prepare_finalizers'
    ELSE 'purge_finalizing' END;
  v_expiry := v_now + lease_duration;
  INSERT INTO dasher.dashboard_cleanup_coordination (
    organization_id, dashboard_id, current_step, lease_owner,
    lease_expires_at, expected_lifecycle_revision, next_attempt_at,
    completion_proof_sha256
  ) VALUES (
    v_organization_id, dashboard_id, v_step, session_user, v_expiry,
    v_new_revision, v_now, NULL
  ) ON CONFLICT ON CONSTRAINT dashboard_cleanup_coordination_pkey DO UPDATE
    SET current_step = EXCLUDED.current_step,
      lease_owner = EXCLUDED.lease_owner,
      lease_expires_at = EXCLUDED.lease_expires_at,
      expected_lifecycle_revision = EXCLUDED.expected_lifecycle_revision,
      next_attempt_at = EXCLUDED.next_attempt_at,
      completion_proof_sha256 = NULL
    WHERE (
      dasher.dashboard_cleanup_coordination.lease_expires_at IS NULL
      OR dasher.dashboard_cleanup_coordination.lease_expires_at <= v_now
    ) AND (
      dasher.dashboard_cleanup_coordination.next_attempt_at IS NULL
      OR dasher.dashboard_cleanup_coordination.next_attempt_at <= v_now
    );
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;
  IF v_proof.proof_id IS NOT NULL THEN
    v_consumption_sha := pg_catalog.sha256(
      pg_catalog.convert_to(
        'dasher.agent-run-drain-consumption.v1', 'UTF8'
      ) || pg_catalog.decode('00', 'hex')
      || pg_catalog.uuid_send(v_organization_id)
      || pg_catalog.uuid_send(dashboard_id)
      || pg_catalog.uuid_send(v_proof.proof_id)
      || pg_catalog.int8send(expected_lifecycle_revision)
      || pg_catalog.int4send(pg_catalog.octet_length(
        v_proof.drain_proof_sha256
      )) || v_proof.drain_proof_sha256
      || pg_catalog.uuid_send(v_proof.cleanup_attempt_id)
      || pg_catalog.int4send(pg_catalog.octet_length(
        v_proof.cleanup_lease_owner
      )) || pg_catalog.convert_to(v_proof.cleanup_lease_owner, 'UTF8')
      || pg_catalog.int8send((extract(epoch FROM
        v_proof.cleanup_lease_expires_at) * 1000000)::bigint)
      || pg_catalog.int4send(pg_catalog.octet_length(session_user::text))
      || pg_catalog.convert_to(session_user::text, 'UTF8')
      || pg_catalog.int8send((
        extract(epoch FROM v_expiry) * 1000000
      )::bigint)
      || pg_catalog.uuid_send(lifecycle_event_and_audit_id)
      || pg_catalog.int8send((
        extract(epoch FROM v_now) * 1000000
      )::bigint)
      || pg_catalog.uuid_send(current_setting(
        'dasher.retention_principal_id', true
      )::uuid)
      || pg_catalog.int8send(v_authority_revision)
    );
    INSERT INTO dasher.dashboard_agent_drain_proof_consumptions (
      organization_id, dashboard_id, proof_id, lifecycle_revision,
      drain_proof_sha256, preceding_cleanup_attempt_id,
      preceding_cleanup_lease_owner, preceding_cleanup_lease_expires_at,
      new_cleanup_lease_owner, new_cleanup_lease_expires_at,
      claim_event_and_audit_id, consumed_at, retention_principal_id,
      retention_principal_revision, consumption_sha256
    ) VALUES (
      v_organization_id, dashboard_id, v_proof.proof_id,
      expected_lifecycle_revision, v_proof.drain_proof_sha256,
      v_proof.cleanup_attempt_id, v_proof.cleanup_lease_owner,
      v_proof.cleanup_lease_expires_at, session_user, v_expiry,
      lifecycle_event_and_audit_id, v_now,
      current_setting('dasher.retention_principal_id', true)::uuid,
      v_authority_revision, v_consumption_sha
    );
    IF v_consumption_sha <>
      dasher_private.recompute_drain_consumption_v1(
        v_organization_id, dashboard_id
      )
    THEN
      RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
    END IF;
  END IF;
  IF v_target_state <> v_dashboard.lifecycle_state THEN
    PERFORM pg_catalog.set_config(
      'dasher.retention_expected_lifecycle_revision',
      expected_lifecycle_revision::text, true
    );
    UPDATE dasher.dashboards AS dashboard
    SET lifecycle_state = v_target_state,
      lifecycle_revision = dashboard.lifecycle_revision + 1
    WHERE dashboard.organization_id = v_organization_id
      AND dashboard.dashboard_id = dashboard_id
      AND dashboard.lifecycle_revision = expected_lifecycle_revision;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
    END IF;
    INSERT INTO dasher.dashboard_lifecycle_events (
      lifecycle_event_id, organization_id, dashboard_id, lifecycle_revision,
      event_kind, from_kind, to_kind, from_state, to_state, occurred_at,
      actor_user_id, actor_service, authority_revision,
      retention_policy_revision, request_id, job_id, reason_sha256
    ) VALUES (
      lifecycle_event_and_audit_id, v_organization_id, dashboard_id,
      v_new_revision, v_event_kind, v_dashboard.current_kind,
      v_dashboard.current_kind, v_dashboard.lifecycle_state, v_target_state,
      v_now, NULL, session_user::text, v_authority_revision,
      v_dashboard.retention_policy_revision,
      current_setting('dasher.retention_request_id', true)::uuid,
      NULL, expected_transition_proof_sha256
    );
    BEGIN
      INSERT INTO dasher.audit_events (
        audit_event_id, organization_id, occurred_at, actor_kind, actor_user_id,
        actor_service, authority_revision, request_id, job_id, action,
        target_type, target_id, outcome, content_sha256, source_ref, provider,
        credential_version, usage_units, cost_minor_units, deployment_revision
      ) VALUES (
        lifecycle_event_and_audit_id, v_organization_id, v_now, 'service', NULL,
        session_user::text, v_authority_revision,
        current_setting('dasher.retention_request_id', true)::uuid, NULL,
        v_audit_action, 'dashboard', dashboard_id, 'succeeded',
        expected_transition_proof_sha256, NULL, NULL, NULL, NULL, NULL,
        deployment_revision
      );
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
    END;
  END IF;
END
$function$;

-- Part 3 - agent-run drain reachability and audit-event-id collision
-- normalization.
--
-- Frozen 0007 makes dasher_retention_api.drain_dashboard_agent_runs
-- unreachable for every caller, in two independent ways. A third correction,
-- the audit-event-id collision normalization described at the end of this
-- header, lands in the same re-issued body for the reason Part 2 gives: this
-- routine is re-issued exactly once in this migration, and the normalization
-- belongs to the body that actually gets installed.
--
-- The first is a missing schema privilege. The function is owned by
-- dasher_retention_definer and declares v_zero, v_run_used and v_run_released
-- of dasher_run_api.attempt_resource_vector and v_mutation of
-- dasher_run_api.run_mutation_result, but frozen 0007 confines USAGE ON SCHEMA
-- dasher_run_api to the security definer and the two run roles. plpgsql
-- resolves declaration types when the body is first compiled, so every call
-- failed before reaching its first statement with "permission denied for
-- schema dasher_run_api". The same omission also blocked
-- dasher_private.append_agent_run_event_v1, which is not SECURITY DEFINER and
-- therefore compiles under whichever role invokes it - the retention definer,
-- on the drain path.
--
-- The grant below is exactly that one schema privilege and nothing more. It
-- confers no right to run anything: each of the twenty-two dasher_run_api
-- routines carries its own explicit privilege list that names only the two run
-- roles, and the schema holds no table, view or sequence, so schema USAGE lets
-- the retention definer name the composite types its own declarations already
-- spell and reach nothing else. No object privilege is added: frozen 0007
-- already issues the retention definer every column-scoped UPDATE and every
-- RLS policy the drain's write path needs on dasher.agent_runs,
-- dasher.agent_run_attempts, dasher.agent_run_events,
-- dasher.agent_run_event_payloads and dasher.agent_run_budget_counters, and
-- Part 1 above already covers dasher.dashboard_agent_drain_proofs.
--
-- The second defect is the legal-hold gate. The frozen drain gate denies on
-- any dasher.dashboard_legal_holds row for the dashboard, released or not,
-- while dasher_retention_api.purge_dashboard filters the same lookup on
-- released_at IS NULL. A dashboard that ever carried a hold could therefore
-- never be drained, so it could never produce the drain proof its own cleanup
-- claim consumes, and drain and purge disagreed on what "held" means.
--
-- The re-issued body below is byte-identical to the frozen 0007 definition
-- apart from a single added line: the hold gate gains
-- "AND hold.released_at IS NULL", the same predicate purge_dashboard already
-- carries, so the two gates now admit exactly the same dashboards. Signature,
-- SECURITY DEFINER, search path, volatility, every declaration, every other
-- predicate, the row-mark clauses, the proof preimages and the conflict paths
-- are preserved. This only narrows what the gate denies on; an unreleased hold
-- still raises dasher_denied exactly as before.
--
-- The third correction is the audit-event-id collision normalization. This
-- function writes dasher.audit_events.audit_event_id - a global primary key -
-- from the caller-supplied p_operation_and_audit_id. It does carry one probe
-- that reads audit_events for that id, but only inside the idempotent-replay
-- branch it takes when this dashboard already has a drain proof for this
-- request, and that probe is conjoined with organization_id, action,
-- target_id, outcome, content_sha256 and deployment_revision, so it can never
-- observe the id being spent by an unrelated audit row. On the first-drain
-- path there is no probe at all. An id already spent in another scope
-- therefore reaches the audit INSERT and PostgreSQL raises a bare 23505
-- carrying the constraint name. The INSERT below is wrapped in the same block
-- Part 6 uses on the age-out, so that duplicate normalizes to the same P1002 /
-- dasher_conflict this function already raises on every other conflict. Only
-- that one statement is inside the block; every FOR UPDATE row mark, every
-- proof recomputation and every other write stays in the outer transaction.
-- The handler re-raises rather than swallowing, so the whole drain unwinds and
-- the dashboard is left exactly as it was before the call.

GRANT USAGE ON SCHEMA dasher_run_api TO dasher_retention_definer;

CREATE OR REPLACE FUNCTION dasher_retention_api.drain_dashboard_agent_runs(
  p_dashboard_id uuid,
  p_expected_lifecycle_revision bigint,
  p_drain_request_proof_sha256 bytea,
  p_operation_and_audit_id uuid,
  p_deployment_revision text,
  p_target_organization_id uuid
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_organization_id uuid;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_coordination dasher.dashboard_cleanup_coordination%ROWTYPE;
  v_run dasher.agent_runs%ROWTYPE;
  v_attempt dasher.agent_run_attempts%ROWTYPE;
  v_field record;
  v_zero dasher_run_api.attempt_resource_vector :=
    ROW(0,0,0,0,0,0,0,0,0,0,0,0,0,0)::dasher_run_api.attempt_resource_vector;
  v_pre_count bigint;
  v_cancelled bigint := 0;
  v_released bigint := 0;
  v_charged bigint := 0;
  v_event_count bigint := 0;
  v_event_id uuid;
  v_payload_id uuid;
  v_nonce bytea;
  v_payload bytea;
  v_payload_sha bytea;
  v_event_sha bytea;
  v_mutation dasher_run_api.run_mutation_result;
  v_run_released_ids uuid[];
  v_run_charged_ids uuid[];
  v_run_used dasher_run_api.attempt_resource_vector;
  v_run_released dasher_run_api.attempt_resource_vector;
  v_accounting_totals record;
  v_first_run uuid;
  v_first_sequence bigint;
  v_first_sha bytea;
  v_last_run uuid;
  v_last_sequence bigint;
  v_last_sha bytea;
  v_range_sha bytea;
  v_range_preimage bytea;
  v_proof_sha bytea;
  v_request_sha bytea;
  v_remaining_nonterminal bigint;
  v_remaining_claimed bigint;
  v_recomputed_event_count bigint := 0;
  v_emitted_event record;
  v_check_first_run uuid;
  v_check_first_sequence bigint;
  v_check_first_sha bytea;
  v_check_last_run uuid;
  v_check_last_sequence bigint;
  v_check_last_sha bytea;
  v_existing_proof dasher.dashboard_agent_drain_proofs%ROWTYPE;
BEGIN
  IF current_user <> 'dasher_retention_definer'::name OR p_dashboard_id IS NULL
    OR p_expected_lifecycle_revision < 1 OR p_target_organization_id IS NULL
    OR pg_catalog.octet_length(p_drain_request_proof_sha256) <> 32
    OR p_operation_and_audit_id IS NULL OR p_deployment_revision IS NULL
    OR p_deployment_revision <> pg_catalog.btrim(p_deployment_revision)
    OR pg_catalog.char_length(p_deployment_revision) NOT BETWEEN 1 AND 64
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  PERFORM dasher_retention_api.initialize_operator_context(
    p_dashboard_id, 'claim_cleanup', p_operation_and_audit_id,
    p_deployment_revision, p_target_organization_id
  );
  v_organization_id := current_setting('dasher.retention_target_organization_id', true)::uuid;
  SELECT coordination.* INTO STRICT v_coordination
  FROM dasher.dashboard_cleanup_coordination AS coordination
  WHERE coordination.organization_id = v_organization_id
    AND coordination.dashboard_id = p_dashboard_id
    AND coordination.expected_lifecycle_revision = p_expected_lifecycle_revision
    AND coordination.lease_owner = session_user
    AND coordination.lease_expires_at > v_now
  FOR UPDATE;
  PERFORM 1 FROM dasher.dashboard_lifecycle_policies AS policy
  WHERE policy.organization_id = v_organization_id
  ORDER BY policy.policy_revision DESC LIMIT 1 FOR UPDATE;
  PERFORM 1 FROM dasher.dashboards AS dashboard
  WHERE dashboard.organization_id = v_organization_id
    AND dashboard.dashboard_id = p_dashboard_id
    AND dashboard.lifecycle_revision = p_expected_lifecycle_revision
    AND dashboard.lifecycle_state IN (
      'access_revoked', 'quarantined', 'purge_eligible'
    ) AND dashboard.purged_at IS NULL
  FOR UPDATE;
  PERFORM 1 FROM dasher.dashboard_legal_holds AS hold
  WHERE hold.organization_id = v_organization_id AND hold.dashboard_id = p_dashboard_id
    AND hold.released_at IS NULL
  ORDER BY hold.hold_id FOR UPDATE;
  IF FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  v_request_sha := pg_catalog.sha256(
    pg_catalog.convert_to('dasher.agent-run-drain-request.v1', 'UTF8')
    || pg_catalog.decode('00', 'hex')
    || pg_catalog.uuid_send(p_dashboard_id)
    || pg_catalog.int8send(p_expected_lifecycle_revision)
    || pg_catalog.uuid_send(p_operation_and_audit_id)
    || pg_catalog.int4send(pg_catalog.octet_length(p_deployment_revision))
    || pg_catalog.convert_to(p_deployment_revision, 'UTF8')
    || pg_catalog.uuid_send(p_target_organization_id)
    || pg_catalog.int4send(pg_catalog.octet_length(v_coordination.current_step))
    || pg_catalog.convert_to(v_coordination.current_step, 'UTF8')
    || pg_catalog.int4send(pg_catalog.octet_length(v_coordination.lease_owner))
    || pg_catalog.convert_to(v_coordination.lease_owner, 'UTF8')
    || pg_catalog.int8send((extract(epoch FROM
      v_coordination.lease_expires_at) * 1000000)::bigint)
    || pg_catalog.uuid_send(current_setting(
      'dasher.retention_principal_id', true
    )::uuid)
    || pg_catalog.int8send(current_setting(
      'dasher.retention_principal_revision', true
    )::bigint)
  );
  IF v_request_sha <> p_drain_request_proof_sha256 THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;
  SELECT proof.* INTO v_existing_proof
  FROM dasher.dashboard_agent_drain_proofs AS proof
    WHERE proof.organization_id = v_organization_id
      AND proof.dashboard_id = p_dashboard_id
      AND proof.drain_request_proof_sha256 = p_drain_request_proof_sha256
  FOR UPDATE;
  IF FOUND THEN
    IF v_existing_proof.proof_id <> p_operation_and_audit_id
      OR v_existing_proof.lifecycle_revision <> p_expected_lifecycle_revision
      OR v_existing_proof.cleanup_attempt_id <> p_operation_and_audit_id
      OR v_existing_proof.cleanup_lease_owner <> v_coordination.lease_owner
      OR v_existing_proof.cleanup_lease_expires_at <> v_coordination.lease_expires_at
      OR v_existing_proof.retention_principal_id <> current_setting(
        'dasher.retention_principal_id', true
      )::uuid
      OR v_existing_proof.retention_principal_revision <> current_setting(
        'dasher.retention_principal_revision', true
      )::bigint
      OR v_existing_proof.event_range_sha256 <>
        dasher_private.recompute_drain_event_range_v1(
          v_organization_id, p_dashboard_id
        )
      OR NOT EXISTS (
        SELECT 1 FROM dasher.audit_events AS audit
        WHERE audit.organization_id = v_organization_id
          AND audit.audit_event_id = p_operation_and_audit_id
          AND audit.action = 'dashboard.agent_runs_drained'
          AND audit.target_id = p_dashboard_id
          AND audit.outcome = 'succeeded'
          AND audit.content_sha256 = v_existing_proof.drain_proof_sha256
          AND audit.deployment_revision = p_deployment_revision
      )
    THEN
      RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
    END IF;
    RETURN;
  END IF;
  SELECT pg_catalog.count(*) INTO v_pre_count FROM dasher.agent_runs AS run
  WHERE run.organization_id = v_organization_id
    AND run.dashboard_id = p_dashboard_id
    AND run.state NOT IN ('rejected','cancelled','expired','failed');
  PERFORM 1 FROM dasher.agent_runs AS run
  WHERE run.organization_id = v_organization_id
    AND run.dashboard_id = p_dashboard_id
  ORDER BY pg_catalog.uuid_send(run.run_id) FOR UPDATE OF run;
  PERFORM 1 FROM dasher.agent_run_events AS event
  WHERE event.organization_id = v_organization_id
    AND event.dashboard_id = p_dashboard_id
  ORDER BY pg_catalog.uuid_send(event.run_id), event.event_sequence
  FOR UPDATE OF event;
  PERFORM 1 FROM dasher.agent_run_budget_counters AS counter
  WHERE counter.organization_id = v_organization_id
    AND counter.dashboard_id = p_dashboard_id
  ORDER BY pg_catalog.uuid_send(counter.run_id), counter.partition,
    counter.vector_field FOR UPDATE OF counter;
  PERFORM 1 FROM dasher.agent_run_attempts AS attempt
  WHERE attempt.organization_id = v_organization_id
    AND attempt.dashboard_id = p_dashboard_id
  ORDER BY pg_catalog.uuid_send(attempt.run_id),
    pg_catalog.uuid_send(attempt.attempt_id) FOR UPDATE OF attempt;
  FOR v_run IN
    SELECT run.* FROM dasher.agent_runs AS run
    WHERE run.organization_id = v_organization_id AND run.dashboard_id = p_dashboard_id
      AND run.state IN (
        'requested', 'authorized', 'planning', 'generating', 'revising',
        'validating', 'approval_required'
      )
    ORDER BY pg_catalog.uuid_send(run.run_id) FOR UPDATE
  LOOP
    v_run_released_ids := ARRAY[]::uuid[];
    v_run_charged_ids := ARRAY[]::uuid[];
    v_run_used := v_zero;
    v_run_released := v_zero;
    PERFORM pg_catalog.set_config(
      'dasher.run_organization_id', v_run.organization_id::text, true
    );
    PERFORM pg_catalog.set_config(
      'dasher.run_dashboard_id', v_run.dashboard_id::text, true
    );
    FOR v_attempt IN
      SELECT attempt.* FROM dasher.agent_run_attempts AS attempt
      WHERE attempt.organization_id = v_run.organization_id
        AND attempt.dashboard_id = v_run.dashboard_id AND attempt.run_id = v_run.run_id
        AND attempt.state IN ('reserved_pre_dispatch', 'dispatch_ready', 'dispatch_started')
      ORDER BY pg_catalog.uuid_send(attempt.attempt_id) FOR UPDATE
    LOOP
      FOR v_field IN
        SELECT item.key AS vector_field, item.value::bigint AS units
        FROM pg_catalog.jsonb_each_text(
          pg_catalog.to_jsonb(v_attempt.outstanding_vector)
        ) AS item ORDER BY item.key
      LOOP
        UPDATE dasher.agent_run_budget_counters AS counter
        SET used_units = counter.used_units + CASE
              WHEN v_attempt.state = 'dispatch_started'
                AND v_field.vector_field <> 'candidates'
              THEN v_field.units ELSE 0 END,
          released_units = counter.released_units + CASE
              WHEN v_attempt.state = 'dispatch_started'
                AND v_field.vector_field <> 'candidates'
              THEN 0 ELSE v_field.units END,
          updated_at = v_now
        WHERE counter.organization_id = v_run.organization_id
          AND counter.dashboard_id = v_run.dashboard_id AND counter.run_id = v_run.run_id
          AND counter.partition = v_attempt.partition
          AND counter.vector_field = v_field.vector_field;
      END LOOP;
      IF v_attempt.state = 'dispatch_started' THEN
        v_charged := v_charged + 1;
        v_run_charged_ids := pg_catalog.array_append(
          v_run_charged_ids, v_attempt.attempt_id
        );
        UPDATE dasher.agent_run_attempts AS attempt
        SET state = 'cancelled_charged', actual_vector = NULL,
          used_vector = ROW(
            (v_attempt.reserved_vector).calls,0,
            (v_attempt.reserved_vector).specialist_attempts,
            (v_attempt.reserved_vector).reviewer_attempts,
            (v_attempt.reserved_vector).repair_attempts,
            (v_attempt.reserved_vector).input_tokens,
            (v_attempt.reserved_vector).output_tokens,
            (v_attempt.reserved_vector).reasoning_tokens,
            (v_attempt.reserved_vector).cache_read_tokens,
            (v_attempt.reserved_vector).cache_write_tokens,
            (v_attempt.reserved_vector).total_tokens,
            (v_attempt.reserved_vector).wall_millis,
            (v_attempt.reserved_vector).work_millis,
            (v_attempt.reserved_vector).cost_micros
          )::dasher_run_api.attempt_resource_vector,
          released_vector = ROW(
            0,(v_attempt.reserved_vector).candidates,0,0,0,0,0,0,0,0,0,0,0,0
          )::dasher_run_api.attempt_resource_vector,
          outstanding_vector = v_zero, reconciled_at = v_now,
          terminal_reason_sha256 = p_drain_request_proof_sha256
        WHERE attempt.organization_id = v_run.organization_id
          AND attempt.dashboard_id = v_run.dashboard_id AND attempt.run_id = v_run.run_id
          AND attempt.attempt_id = v_attempt.attempt_id;
        v_mutation := dasher_private.append_agent_run_event_v1(
          v_run.run_id,
          dasher_private.uuid_v8_from_sha256_v1(pg_catalog.sha256(
            pg_catalog.convert_to(
              'dasher.cleanup-cancel-charged-event-id.v1', 'UTF8'
            ) || pg_catalog.uuid_send(p_operation_and_audit_id)
              || pg_catalog.uuid_send(v_attempt.attempt_id)
          )),
          'attempt_cancelled_charged',
          pg_catalog.convert_to(pg_catalog.jsonb_build_object(
            'attempt_id', v_attempt.attempt_id::text,
            'cancel_operation_id', p_operation_and_audit_id::text,
            'used_vector', pg_catalog.to_jsonb(ROW(
              (v_attempt.reserved_vector).calls,0,
              (v_attempt.reserved_vector).specialist_attempts,
              (v_attempt.reserved_vector).reviewer_attempts,
              (v_attempt.reserved_vector).repair_attempts,
              (v_attempt.reserved_vector).input_tokens,
              (v_attempt.reserved_vector).output_tokens,
              (v_attempt.reserved_vector).reasoning_tokens,
              (v_attempt.reserved_vector).cache_read_tokens,
              (v_attempt.reserved_vector).cache_write_tokens,
              (v_attempt.reserved_vector).total_tokens,
              (v_attempt.reserved_vector).wall_millis,
              (v_attempt.reserved_vector).work_millis,
              (v_attempt.reserved_vector).cost_micros
            )::dasher_run_api.attempt_resource_vector),
            'released_vector', pg_catalog.to_jsonb(ROW(
              0,(v_attempt.reserved_vector).candidates,0,0,0,0,0,
              0,0,0,0,0,0,0
            )::dasher_run_api.attempt_resource_vector)
          )::text, 'UTF8')
        );
      ELSE
        v_released := v_released + 1;
        v_run_released_ids := pg_catalog.array_append(
          v_run_released_ids, v_attempt.attempt_id
        );
        UPDATE dasher.agent_run_attempts AS attempt
        SET state = 'cancelled_released', used_vector = v_zero,
          released_vector = v_attempt.reserved_vector, outstanding_vector = v_zero,
          reconciled_at = v_now, terminal_reason_sha256 = p_drain_request_proof_sha256
        WHERE attempt.organization_id = v_run.organization_id
          AND attempt.dashboard_id = v_run.dashboard_id AND attempt.run_id = v_run.run_id
          AND attempt.attempt_id = v_attempt.attempt_id;
        v_mutation := dasher_private.append_agent_run_event_v1(
          v_run.run_id,
          dasher_private.uuid_v8_from_sha256_v1(pg_catalog.sha256(
            pg_catalog.convert_to(
              'dasher.cleanup-cancel-released-event-id.v1', 'UTF8'
            ) || pg_catalog.uuid_send(p_operation_and_audit_id)
              || pg_catalog.uuid_send(v_attempt.attempt_id)
          )),
          'attempt_cancelled_released',
          pg_catalog.convert_to(pg_catalog.jsonb_build_object(
            'attempt_id', v_attempt.attempt_id::text,
            'cancel_operation_id', p_operation_and_audit_id::text,
            'used_vector', pg_catalog.to_jsonb(v_zero),
            'released_vector', pg_catalog.to_jsonb(v_attempt.reserved_vector)
          )::text, 'UTF8')
        );
      END IF;
      v_event_count := v_event_count + 1;
      IF v_first_run IS NULL THEN
        v_first_run := v_mutation.run_id;
        v_first_sequence := v_mutation.event_sequence;
        v_first_sha := v_mutation.event_sha256;
      END IF;
      v_last_run := v_mutation.run_id;
      v_last_sequence := v_mutation.event_sequence;
      v_last_sha := v_mutation.event_sha256;
    END LOOP;
    SELECT ROW(
      COALESCE(pg_catalog.sum((attempt.used_vector).calls),0),
      COALESCE(pg_catalog.sum((attempt.used_vector).candidates),0),
      COALESCE(pg_catalog.sum((attempt.used_vector).specialist_attempts),0),
      COALESCE(pg_catalog.sum((attempt.used_vector).reviewer_attempts),0),
      COALESCE(pg_catalog.sum((attempt.used_vector).repair_attempts),0),
      COALESCE(pg_catalog.sum((attempt.used_vector).input_tokens),0),
      COALESCE(pg_catalog.sum((attempt.used_vector).output_tokens),0),
      COALESCE(pg_catalog.sum((attempt.used_vector).reasoning_tokens),0),
      COALESCE(pg_catalog.sum((attempt.used_vector).cache_read_tokens),0),
      COALESCE(pg_catalog.sum((attempt.used_vector).cache_write_tokens),0),
      COALESCE(pg_catalog.sum((attempt.used_vector).total_tokens),0),
      COALESCE(pg_catalog.sum((attempt.used_vector).wall_millis),0),
      COALESCE(pg_catalog.sum((attempt.used_vector).work_millis),0),
      COALESCE(pg_catalog.sum((attempt.used_vector).cost_micros),0)
    )::dasher_run_api.attempt_resource_vector AS used_vector,
    ROW(
      COALESCE(pg_catalog.sum((attempt.released_vector).calls),0),
      COALESCE(pg_catalog.sum((attempt.released_vector).candidates),0),
      COALESCE(pg_catalog.sum((attempt.released_vector).specialist_attempts),0),
      COALESCE(pg_catalog.sum((attempt.released_vector).reviewer_attempts),0),
      COALESCE(pg_catalog.sum((attempt.released_vector).repair_attempts),0),
      COALESCE(pg_catalog.sum((attempt.released_vector).input_tokens),0),
      COALESCE(pg_catalog.sum((attempt.released_vector).output_tokens),0),
      COALESCE(pg_catalog.sum((attempt.released_vector).reasoning_tokens),0),
      COALESCE(pg_catalog.sum((attempt.released_vector).cache_read_tokens),0),
      COALESCE(pg_catalog.sum((attempt.released_vector).cache_write_tokens),0),
      COALESCE(pg_catalog.sum((attempt.released_vector).total_tokens),0),
      COALESCE(pg_catalog.sum((attempt.released_vector).wall_millis),0),
      COALESCE(pg_catalog.sum((attempt.released_vector).work_millis),0),
      COALESCE(pg_catalog.sum((attempt.released_vector).cost_micros),0)
    )::dasher_run_api.attempt_resource_vector AS released_vector
    INTO v_accounting_totals
    FROM dasher.agent_run_attempts AS attempt
    WHERE attempt.organization_id = v_run.organization_id
      AND attempt.dashboard_id = v_run.dashboard_id
      AND attempt.run_id = v_run.run_id
      AND attempt.attempt_id = ANY(
        v_run_released_ids || v_run_charged_ids
      );
    v_run_used := v_accounting_totals.used_vector;
    v_run_released := v_accounting_totals.released_vector;
    SELECT current_run.* INTO STRICT v_run
    FROM dasher.agent_runs AS current_run
    WHERE current_run.organization_id = v_organization_id
      AND current_run.dashboard_id = p_dashboard_id
      AND current_run.run_id = v_run.run_id
    FOR UPDATE;
    PERFORM pg_catalog.set_config('dasher.run_next_state', 'cancelled', true);
    PERFORM pg_catalog.set_config('dasher.run_clear_lease', 'true', true);
    PERFORM pg_catalog.set_config(
      'dasher.run_terminal_reason_sha256',
      pg_catalog.encode(p_drain_request_proof_sha256, 'hex'), true
    );
    v_mutation := dasher_private.append_agent_run_event_v1(
      v_run.run_id,
      dasher_private.uuid_v8_from_sha256_v1(pg_catalog.sha256(
        pg_catalog.convert_to(
          'dasher.cleanup-cancel-aggregate-event-id.v1', 'UTF8'
        ) || pg_catalog.uuid_send(p_operation_and_audit_id)
          || pg_catalog.uuid_send(v_run.run_id)
      )),
      'run_cleanup_cancelled',
      pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'cancel_operation_id', p_operation_and_audit_id::text,
      'charged_attempt_ids', pg_catalog.to_jsonb(v_run_charged_ids),
      'fenced_lease_epoch', 'i64:' || (v_run.lease_epoch + 1)::text,
      'reason_sha256', pg_catalog.encode(p_drain_request_proof_sha256, 'hex'),
      'released_attempt_ids', pg_catalog.to_jsonb(v_run_released_ids),
      'released_vector', pg_catalog.to_jsonb(v_run_released),
      'used_vector', pg_catalog.to_jsonb(v_run_used)
      )::text, 'UTF8')
    );
    v_cancelled := v_cancelled + 1;
    v_event_count := v_event_count + 1;
    IF v_first_run IS NULL THEN
      v_first_run := v_mutation.run_id;
      v_first_sequence := v_mutation.event_sequence;
      v_first_sha := v_mutation.event_sha256;
    END IF;
    v_last_run := v_mutation.run_id;
    v_last_sequence := v_mutation.event_sequence;
    v_last_sha := v_mutation.event_sha256;
  END LOOP;
  SELECT pg_catalog.count(*) FILTER (
      WHERE run.state NOT IN ('rejected','cancelled','expired','failed')
    ), pg_catalog.count(*) FILTER (
      WHERE run.lease_token_sha256 IS NOT NULL
        OR run.lease_owner_principal_id IS NOT NULL
        OR run.lease_owner_principal_revision IS NOT NULL
        OR run.lease_expires_at IS NOT NULL
    )
    INTO v_remaining_nonterminal, v_remaining_claimed
  FROM dasher.agent_runs AS run
  WHERE run.organization_id = v_organization_id
    AND run.dashboard_id = p_dashboard_id;
  IF v_remaining_nonterminal <> 0 OR v_remaining_claimed <> 0
    OR v_cancelled <> v_pre_count
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;
  v_range_preimage :=
    pg_catalog.convert_to('dasher.agent-run-drain-event-range.v1', 'UTF8')
    || pg_catalog.decode('00', 'hex') || pg_catalog.int8send(v_event_count);
  FOR v_emitted_event IN
    SELECT event.* FROM dasher.agent_run_events AS event
    WHERE event.organization_id = v_organization_id
      AND event.dashboard_id = p_dashboard_id
      AND (
        event.event_id = dasher_private.uuid_v8_from_sha256_v1(pg_catalog.sha256(
          pg_catalog.convert_to('dasher.cleanup-cancel-aggregate-event-id.v1', 'UTF8')
          || pg_catalog.decode('00', 'hex')
          || pg_catalog.uuid_send(p_operation_and_audit_id)
          || pg_catalog.uuid_send(event.run_id)
        ))
        OR EXISTS (
          SELECT 1 FROM dasher.agent_run_attempts AS attempt
          WHERE attempt.organization_id = event.organization_id
            AND attempt.dashboard_id = event.dashboard_id
            AND attempt.run_id = event.run_id
            AND attempt.state IN ('cancelled_charged','cancelled_released')
            AND event.event_id = dasher_private.uuid_v8_from_sha256_v1(
              pg_catalog.sha256(pg_catalog.convert_to(CASE
                WHEN attempt.state = 'cancelled_charged'
                  THEN 'dasher.cleanup-cancel-charged-event-id.v1'
                ELSE 'dasher.cleanup-cancel-released-event-id.v1' END, 'UTF8')
                || pg_catalog.uuid_send(p_operation_and_audit_id)
                || pg_catalog.uuid_send(attempt.attempt_id))
            )
        )
      )
    ORDER BY pg_catalog.uuid_send(event.run_id), event.event_sequence
  LOOP
    v_recomputed_event_count := v_recomputed_event_count + 1;
    IF v_recomputed_event_count = 1 THEN
      v_check_first_run := v_emitted_event.run_id;
      v_check_first_sequence := v_emitted_event.event_sequence;
      v_check_first_sha := v_emitted_event.event_sha256;
    END IF;
    v_check_last_run := v_emitted_event.run_id;
    v_check_last_sequence := v_emitted_event.event_sequence;
    v_check_last_sha := v_emitted_event.event_sha256;
    v_range_preimage := v_range_preimage
      || pg_catalog.uuid_send(v_emitted_event.run_id)
      || pg_catalog.int8send(v_emitted_event.event_sequence)
      || pg_catalog.int4send(pg_catalog.octet_length(v_emitted_event.event_sha256))
      || v_emitted_event.event_sha256;
  END LOOP;
  IF v_recomputed_event_count <> v_event_count
    OR v_check_first_run IS DISTINCT FROM v_first_run
    OR v_check_first_sequence IS DISTINCT FROM v_first_sequence
    OR v_check_first_sha IS DISTINCT FROM v_first_sha
    OR v_check_last_run IS DISTINCT FROM v_last_run
    OR v_check_last_sequence IS DISTINCT FROM v_last_sequence
    OR v_check_last_sha IS DISTINCT FROM v_last_sha
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;
  v_range_sha := pg_catalog.sha256(v_range_preimage);
  v_proof_sha := pg_catalog.sha256(
    pg_catalog.convert_to('dasher.agent-run-drain-proof.v1', 'UTF8')
    || pg_catalog.decode('00', 'hex')
    || pg_catalog.int4send(pg_catalog.octet_length(p_drain_request_proof_sha256))
    || p_drain_request_proof_sha256
    || pg_catalog.uuid_send(p_dashboard_id)
    || pg_catalog.int8send(p_expected_lifecycle_revision)
    || pg_catalog.uuid_send(p_operation_and_audit_id)
    || pg_catalog.int4send(pg_catalog.octet_length(p_deployment_revision))
    || pg_catalog.convert_to(p_deployment_revision, 'UTF8')
    || pg_catalog.uuid_send(p_target_organization_id)
    || pg_catalog.int4send(pg_catalog.octet_length(v_coordination.current_step))
    || pg_catalog.convert_to(v_coordination.current_step, 'UTF8')
    || pg_catalog.int4send(pg_catalog.octet_length(v_coordination.lease_owner))
    || pg_catalog.convert_to(v_coordination.lease_owner, 'UTF8')
    || pg_catalog.int8send((extract(epoch FROM
      v_coordination.lease_expires_at) * 1000000)::bigint)
    || pg_catalog.uuid_send(current_setting(
      'dasher.retention_principal_id', true
    )::uuid)
    || pg_catalog.int8send(current_setting(
      'dasher.retention_principal_revision', true
    )::bigint)
    || pg_catalog.int8send(v_pre_count) || pg_catalog.int8send(v_cancelled)
    || pg_catalog.int8send(v_released) || pg_catalog.int8send(v_charged)
    || pg_catalog.int8send(v_remaining_nonterminal)
    || pg_catalog.int8send(v_remaining_claimed)
    || CASE WHEN v_first_run IS NULL THEN pg_catalog.decode('00','hex')
      ELSE pg_catalog.decode('01','hex') || pg_catalog.uuid_send(v_first_run) END
    || CASE WHEN v_first_sequence IS NULL THEN pg_catalog.decode('00','hex')
      ELSE pg_catalog.decode('01','hex') || pg_catalog.int8send(v_first_sequence) END
    || CASE WHEN v_first_sha IS NULL THEN pg_catalog.decode('00','hex')
      ELSE pg_catalog.decode('01','hex')
        || pg_catalog.int4send(pg_catalog.octet_length(v_first_sha)) || v_first_sha END
    || CASE WHEN v_last_run IS NULL THEN pg_catalog.decode('00','hex')
      ELSE pg_catalog.decode('01','hex') || pg_catalog.uuid_send(v_last_run) END
    || CASE WHEN v_last_sequence IS NULL THEN pg_catalog.decode('00','hex')
      ELSE pg_catalog.decode('01','hex') || pg_catalog.int8send(v_last_sequence) END
    || CASE WHEN v_last_sha IS NULL THEN pg_catalog.decode('00','hex')
      ELSE pg_catalog.decode('01','hex')
        || pg_catalog.int4send(pg_catalog.octet_length(v_last_sha)) || v_last_sha END
    || pg_catalog.int8send(v_event_count)
    || pg_catalog.int4send(pg_catalog.octet_length(v_range_sha)) || v_range_sha
    || pg_catalog.int8send((
      extract(epoch FROM v_now) * 1000000
    )::bigint)
  );
  INSERT INTO dasher.dashboard_agent_drain_proofs (
    organization_id, dashboard_id, proof_id, lifecycle_revision,
    cleanup_attempt_id, cleanup_lease_owner, cleanup_lease_expires_at,
    retention_principal_id, retention_principal_revision, pre_drain_run_count,
    cancelled_run_count, released_attempt_count, charged_attempt_count,
    remaining_nonterminal_run_count, remaining_claimed_run_count,
    first_event_run_id, first_event_sequence, first_event_sha256,
    last_event_run_id, last_event_sequence, last_event_sha256, event_count,
    event_range_sha256, generated_at, drain_request_proof_sha256,
    drain_proof_sha256
  ) VALUES (
    v_organization_id, p_dashboard_id, p_operation_and_audit_id,
    p_expected_lifecycle_revision, p_operation_and_audit_id,
    v_coordination.lease_owner, v_coordination.lease_expires_at,
    current_setting('dasher.retention_principal_id', true)::uuid,
    current_setting('dasher.retention_principal_revision', true)::bigint,
    v_pre_count, v_cancelled, v_released, v_charged,
    v_remaining_nonterminal, v_remaining_claimed,
    v_first_run, v_first_sequence, v_first_sha, v_last_run, v_last_sequence,
    v_last_sha, v_event_count, v_range_sha, v_now,
    p_drain_request_proof_sha256, v_proof_sha
  );
  BEGIN
    INSERT INTO dasher.audit_events (
      audit_event_id, organization_id, occurred_at, actor_kind, actor_user_id,
      actor_service, authority_revision, request_id, job_id, action, target_type,
      target_id, outcome, content_sha256, source_ref, provider,
      credential_version, usage_units, cost_minor_units, deployment_revision
    ) VALUES (
      p_operation_and_audit_id, v_organization_id, v_now, 'service', NULL,
      session_user::text,
      current_setting('dasher.retention_principal_revision', true)::bigint,
      current_setting('dasher.retention_request_id', true)::uuid, NULL,
      'dashboard.agent_runs_drained', 'dashboard', p_dashboard_id, 'succeeded',
      v_proof_sha, NULL, NULL, NULL, NULL, NULL, p_deployment_revision
    );
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END;
END
$function$;

-- Part 4 - dasher.dashboard_cleanup_attempts retention SELECT visibility.
--
-- Frozen 0003 gives dasher.dashboard_cleanup_attempts a single retention
-- SELECT policy, dashboard_cleanup_attempts_retention_select, whose capability
-- array admits only 'record_attempt' and 'purge'. Every other predicate the
-- policy carries is the standard retention predicate this series uses
-- everywhere.
--
-- dasher_retention_api.claim_dashboard_cleanup opens its operator context with
-- capability 'claim_cleanup' and then, on its proof-carrying branch only, runs
-- "SELECT attempt.* INTO STRICT v_attempt" over that relation to check the
-- successful cleanup attempt that closed the drain proof it is about to
-- consume. Under 'claim_cleanup' the frozen policy admitted no row, so the
-- STRICT select raised "query returned no rows" (P0002) for every
-- proof-carrying claim. access_revoked -> quarantined -> purge_eligible was
-- therefore unreachable, dasher_retention_api.purge_dashboard could never see
-- a 'purge_eligible' dashboard, and drain proofs accumulated unconsumed.
--
-- The policy below is re-issued with the DROP-then-CREATE convention 0006
-- already uses for replacing a policy, and changes in exactly one place:
-- 'claim_cleanup' is inserted at the head of the capability array. Nothing
-- else moves. Every remaining conjunct is carried over character for character
-- - the current_user check, the 'authorized' phase, the non-empty principal id
-- and revision, the 'platform_operator' authority scope, the allowlist EXISTS
-- with its postgres_session_user binding to SESSION_USER, enabled,
-- can_initialize, the no-later-revision NOT EXISTS, the per-capability CASE
-- that resolves 'claim_cleanup' to bound_authority.can_claim_cleanup, and the
-- organization and dashboard scoping against the operator-context GUCs. A
-- SELECT policy carries no WITH CHECK and none is added.
--
-- The capability list this produces is the one
-- dasher_private.retention_policy_allows_v1 already applies to the retention
-- definer's lock policies on every other relation, and the one frozen 0003
-- already admits on dasher.dashboard_cleanup_coordination for SELECT. It
-- widens nothing: 'claim_cleanup' still reaches a row only through a principal
-- whose latest allowlist revision carries can_claim_cleanup, bound to this
-- SESSION_USER, inside an authorized operator context scoped to the row's own
-- organization and dashboard.
--
-- The lock policy Part 1 issues on the same relation carries the identical
-- single insertion, at its own site above rather than here. The claim reads
-- the attempt with FOR UPDATE, and under row-level security a locking SELECT
-- silently drops every row the UPDATE policies' USING quals reject, so a lock
-- policy left on the two-element array would have kept the row invisible to
-- exactly the statement this part unblocks. Carrying the insertion in Part 1
-- keeps that policy created once, and keeps the invariant Part 1 states: the
-- lockable set still equals the visible set, and WITH CHECK (false) still
-- makes every UPDATE through it produce no row.

DROP POLICY dashboard_cleanup_attempts_retention_select
  ON dasher.dashboard_cleanup_attempts;

CREATE POLICY dashboard_cleanup_attempts_retention_select
ON dasher.dashboard_cleanup_attempts
AS PERMISSIVE
FOR SELECT
TO dasher_retention_definer
USING (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['claim_cleanup'::text, 'record_attempt'::text, 'purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)))
;

-- Part 5 - dasher.audit_events column-scoped retention SELECT authority.

-- dasher_private.recompute_drain_proof_v1 is the helper both
-- dasher_retention_api.claim_dashboard_cleanup and
-- dasher_retention_api.purge_dashboard use to re-derive a drain proof from the
-- rows that produced it, and to refuse to consume one whose stored digest no
-- longer matches. It is SECURITY DEFINER and owned by dasher_retention_definer,
-- and its FROM list inner-joins dasher.audit_events to bind the proof to the
-- audit row that recorded the drain: on organization_id, on
-- audit_event_id = proof.proof_id, on action 'dashboard.agent_runs_drained',
-- on outcome 'succeeded' and on content_sha256 = proof.drain_proof_sha256. It
-- reads one further column from that join, audit.deployment_revision, straight
-- into the proof preimage.
--
-- Frozen 0003 grants dasher_retention_definer INSERT on dasher.audit_events and
-- nothing else, and the relation both enables and forces row-level security
-- with no SELECT policy for that role at all. Every call therefore failed with
-- "permission denied for table audit_events" - on the cleanup claim's
-- proof-carrying branch, one statement past the attempt read Part 4 unblocks,
-- and again inside purge_dashboard's proof verification. access_revoked ->
-- quarantined -> purge_eligible -> purged was unreachable from the far side of
-- Part 4 exactly as it was from the near side.
--
-- Both halves below are required, and the grant alone would be worse than the
-- frozen state rather than better: under forced row-level security a role
-- holding SELECT with no policy that admits a row reads an empty relation
-- instead of raising. The inner join would then match nothing, the helper would
-- return NULL, and both callers would compare a stored digest against NULL.
-- Vacuous proof verification is precisely what this helper exists to prevent,
-- so the policy is what makes the grant safe, not an addition to it.
--
-- The grant is column-scoped, in the form 0002 and 0007 already use for the
-- other two roles that read this relation: neither dasher_app nor
-- dasher_security_definer holds table-level SELECT on dasher.audit_events,
-- each names its columns. Those two enumerate all twenty, because each serves
-- a general audit read path. This role's reads are four statements wide, so
-- its list is the union of the columns those four - the same four the policy
-- note below enumerates for the capability array - actually reference:
--
--   * dasher_private.recompute_drain_proof_v1 (0007:20631) joins on
--     organization_id, audit_event_id, action, outcome and content_sha256,
--     and reads deployment_revision into the proof preimage (0007:20586).
--   * dasher_retention_api.drain_dashboard_agent_runs, as Part 3 above
--     re-issues it, adds target_id to that same set.
--   * dasher_retention_api.age_out_dashboard_agent_run_metadata (0007:24049)
--     adds target_type; its second probe (0007:24064) reads audit_event_id
--     alone.
--
-- Eight columns of the twenty. The twelve left out - occurred_at, actor_kind,
-- actor_user_id, actor_service, authority_revision, request_id, job_id,
-- source_ref, provider, credential_version, usage_units and cost_minor_units -
-- are the actor, provenance and billing columns of every audit row this role
-- could otherwise see, and not one statement it executes reads any of them.
-- The policy's own predicate needs organization_id, target_type and target_id,
-- all three already in the list, so column scoping takes nothing away from the
-- row scoping and the policy below is unchanged by it.

GRANT SELECT (
  audit_event_id, organization_id, action, target_type, target_id,
  outcome, content_sha256, deployment_revision
) ON TABLE dasher.audit_events
  TO dasher_retention_definer;

-- The predicate is the standard retention SELECT predicate this series applies
-- on every other relation, carried over conjunct for conjunct from the policy
-- Part 4 re-issues: the CURRENT_USER check, the 'authorized' phase, the
-- non-empty principal id and revision, the 'platform_operator' authority scope,
-- the allowlist EXISTS with its postgres_session_user binding to SESSION_USER,
-- enabled, can_initialize, the no-later-revision NOT EXISTS, and the
-- per-capability CASE that resolves the 'dasher.retention_capability' GUC to
-- the matching allowlist column. Only the capability array and the row scoping
-- are specific to this relation.
--
-- The capability array is read off the call graph rather than copied. Four
-- statements under dasher_retention_definer read dasher.audit_events, and only
-- four:
--
--   * dasher_private.recompute_drain_proof_v1 (0007:20631), reached from
--     dasher_retention_api.claim_dashboard_cleanup (0007:21169), which opens
--     its operator context with capability 'claim_cleanup', and from
--     dasher_retention_api.purge_dashboard (0007:22412), which opens its own
--     with 'purge'.
--   * dasher_retention_api.drain_dashboard_agent_runs (0007:21731), on its
--     already-drained replay branch only, under 'claim_cleanup'.
--   * dasher_retention_api.age_out_dashboard_agent_run_metadata (0007:24049
--     and 0007:24064), under 'purge'.
--
-- That is 'claim_cleanup' and 'purge' and nothing else. In particular
-- 'record_attempt' is excluded: dasher_retention_api.record_dashboard_cleanup_attempt
-- neither names dasher.audit_events nor calls any helper that does, so
-- admitting it would widen the read surface past anything the traversal
-- executes. 'materialize_expiry', 'place_hold' and 'release_hold' are excluded
-- for the same reason. The three last-named capabilities do write audit rows
-- through the frozen INSERT grant; none of them reads one back.
--
-- The row scoping is the operator context's own target. organization_id is what
-- the join demonstrably needs - every one of the four statements above either
-- spells an organization_id equality itself or is a uniqueness probe within one
-- organization - and it is the same GUC comparison every retention policy in
-- the series carries. target_type and target_id narrow further: every audit row
-- these statements look for is one a retention operation wrote about a whole
-- dashboard, with target_type 'dashboard' and target_id the dashboard id, and
-- the operator context has already pinned that dashboard in
-- 'dasher.retention_target_dashboard_id'. So the visible set is the audit trail
-- of the single dashboard this operator is currently authorized to act on, and
-- not one row of any other dashboard's, any other organization's, or any
-- audit row whose target is a user, a membership, a session or a run.
--
-- The action set is deliberately not narrowed further. 0007:24064 is an
-- action-agnostic probe - it asks whether p_operation_and_audit_id has already
-- been spent as an audit event id at all - and pinning the policy to the
-- retention actions would silently turn that guard into a weaker one. Within a
-- single dashboard's own audit trail there is nothing the role authorized to
-- purge that entire dashboard may not see.
--
-- This is a SELECT policy, so it carries no WITH CHECK and none is added. No
-- UPDATE and no DELETE privilege is granted here or anywhere in this file for
-- dasher.audit_events, the frozen 0001 audit_events_immutable trigger still
-- rejects both before any row is touched, and the frozen INSERT grant and its
-- policies are untouched: the audit log stays append-only.

CREATE POLICY audit_events_retention_select
ON dasher.audit_events
AS PERMISSIVE
FOR SELECT
TO dasher_retention_definer
USING (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['claim_cleanup'::text, 'purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (target_type = 'dashboard'::text) AND (target_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)))
;

-- Part 6 - age-out operation-id collision normalization.
--
-- Frozen 0007 guards dasher_retention_api.age_out_dashboard_agent_run_metadata
-- against a replayed operation id with two probes. The first (0007:24049) is
-- the idempotent-replay branch: it looks up this dashboard's own age-out proof
-- and, when one exists, re-verifies every recorded digest against what the
-- caller is asking to write again. The second (0007:24063) is a deliberately
-- global uniqueness probe. It asks whether p_operation_and_audit_id has already
-- been spent as an audit event id at all - naming audit.audit_event_id and
-- nothing else, with no organization, target or action conjunct - and raises
-- P1002 / dasher_conflict when it has. audit_event_id is the primary key of
-- dasher.audit_events, so reading the whole relation was the point: an
-- operation id is spent once it names any audit row, whatever that row is
-- about.
--
-- Part 5 above gives dasher_retention_definer the SELECT authority both probes
-- always needed, and scopes it - to the operator context's own organization, to
-- target_type 'dashboard', and to the target dashboard id. That scoping is
-- right for the four statements it was derived from, and it is what keeps this
-- role out of every other dashboard's audit trail. It also, unavoidably,
-- narrows the second probe from global to per-dashboard. An operation id
-- already spent by an audit row belonging to a different dashboard, a different
-- target type or a different organization is not visible to it, so the probe
-- finds nothing and the function proceeds.
--
-- It then performs the whole age-out - the deletes, the counters, the proof
-- insert - and reaches its own audit INSERT (0007:24292), where the primary key
-- is still global and still refuses the duplicate. PostgreSQL raises a bare
-- 23505 carrying the constraint name. That is the one outcome this series does
-- not permit a retention entry point to emit: a duplicate non-idempotent
-- operation must normalize to P1002 without exposing SQL, constraints, or
-- existence detail.
--
-- The re-issued body below is byte-identical to the frozen 0007 definition
-- apart from that INSERT, which is wrapped in a block whose only handler turns
-- unique_violation into the same P1002 / dasher_conflict every other conflict
-- path in this function already raises. Signature, SECURITY DEFINER, search
-- path, volatility, every declaration, both probes, every predicate, every
-- proof preimage and every other RAISE are preserved.
--
-- This normalizes an error; it does not widen a read. The handler learns only
-- that the INSERT it just issued violated a unique constraint - which the
-- caller was going to be told regardless - and it reports strictly less than
-- PostgreSQL would have. Part 5's grant and policy are untouched: the role
-- still reads eight columns of one dashboard's audit trail and no row of any
-- other's, and the collision is now caught at the write boundary instead of
-- being missed at the read boundary. The handler re-raises rather than
-- swallowing, so its block's subtransaction unwinds the audit INSERT and the
-- propagating exception unwinds everything the call had already done - the
-- deletes, the proof row, the counters - leaving the dashboard exactly as it
-- was before the call.

CREATE OR REPLACE FUNCTION dasher_retention_api.age_out_dashboard_agent_run_metadata(
  p_dashboard_id uuid,
  p_expected_lifecycle_revision bigint,
  p_tombstone_backup_source_proof_sha256 bytea,
  p_operation_and_audit_id uuid,
  p_deployment_revision text,
  p_target_organization_id uuid
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_organization_id uuid;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_dashboard dasher.dashboards%ROWTYPE;
  v_tombstone dasher.dashboard_tombstones%ROWTYPE;
  v_ledger dasher.backup_deletion_ledger%ROWTYPE;
  v_existing dasher.dashboard_agent_run_age_out_proofs%ROWTYPE;
  v_principal_id uuid;
  v_principal_revision bigint;
  v_source_sha bytea;
  v_chain_sha bytea;
  v_age_sha bytea;
  v_chain_preimage bytea;
  v_prior_event_sha bytea;
  v_expected_event_sequence bigint;
  v_recomputed_events bigint := 0;
  v_event_sum numeric := 0;
  v_run record;
  v_event record;
  v_runs bigint;
  v_events bigint;
  v_checkpoints bigint;
  v_attempts bigint;
  v_counters bigint;
  v_consumptions bigint;
  v_proofs bigint;
  v_deleted bigint;
BEGIN
  IF current_user <> 'dasher_retention_definer'::name OR p_dashboard_id IS NULL
    OR p_expected_lifecycle_revision < 1 OR p_target_organization_id IS NULL
    OR pg_catalog.octet_length(p_tombstone_backup_source_proof_sha256) <> 32
    OR p_operation_and_audit_id IS NULL OR p_deployment_revision IS NULL
    OR p_deployment_revision <> pg_catalog.btrim(p_deployment_revision)
    OR pg_catalog.char_length(p_deployment_revision) NOT BETWEEN 1 AND 64
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  PERFORM dasher_retention_api.initialize_operator_context(
    p_dashboard_id, 'purge', p_operation_and_audit_id,
    p_deployment_revision, p_target_organization_id
  );
  PERFORM pg_catalog.set_config(
    'dasher.retention_deployment_revision', p_deployment_revision, true
  );
  v_organization_id := current_setting('dasher.retention_target_organization_id', true)::uuid;
  v_principal_id := current_setting(
    'dasher.retention_principal_id', true
  )::uuid;
  v_principal_revision := current_setting(
    'dasher.retention_principal_revision', true
  )::bigint;
  PERFORM 1 FROM dasher.dashboard_cleanup_coordination AS coordination
  WHERE coordination.organization_id = v_organization_id
    AND coordination.dashboard_id = p_dashboard_id
    AND coordination.current_step = 'cleaned'
    AND coordination.expected_lifecycle_revision =
      p_expected_lifecycle_revision
  FOR UPDATE OF coordination;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;
  PERFORM 1 FROM dasher.dashboard_lifecycle_policies AS policy
  WHERE policy.organization_id = v_organization_id
  ORDER BY policy.policy_revision DESC LIMIT 1 FOR UPDATE;
  SELECT dashboard.* INTO STRICT v_dashboard
  FROM dasher.dashboards AS dashboard
  WHERE dashboard.organization_id = v_organization_id
    AND dashboard.dashboard_id = p_dashboard_id
    AND dashboard.lifecycle_revision = p_expected_lifecycle_revision
    AND dashboard.lifecycle_state = 'cleaned' AND dashboard.purged_at IS NOT NULL
    AND dashboard.purged_at <= v_now - interval '365 days'
  FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM dasher.dashboard_legal_holds AS hold
    WHERE hold.organization_id = v_organization_id
      AND hold.dashboard_id = p_dashboard_id AND hold.released_at IS NULL
    ORDER BY hold.hold_id
    FOR UPDATE OF hold
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  SELECT tombstone.* INTO STRICT v_tombstone
  FROM dasher.dashboard_tombstones AS tombstone
  WHERE tombstone.organization_id = v_organization_id
    AND tombstone.tombstone_lineage_id = v_dashboard.tombstone_lineage_id
    AND tombstone.purged_at = v_dashboard.purged_at
    AND tombstone.purged_lifecycle_revision = v_dashboard.lifecycle_revision
  FOR UPDATE;
  SELECT ledger.* INTO STRICT v_ledger
  FROM dasher.backup_deletion_ledger AS ledger
  WHERE ledger.organization_id = v_organization_id
    AND ledger.tombstone_lineage_id = v_tombstone.tombstone_lineage_id
    AND ledger.event_kind = 'backup.deleted'
  ORDER BY ledger.ledger_sequence DESC
  LIMIT 1
  FOR UPDATE;

  PERFORM 1 FROM dasher.agent_runs AS run
  WHERE run.organization_id = v_organization_id
    AND run.dashboard_id = p_dashboard_id
  ORDER BY pg_catalog.uuid_send(run.run_id)
  FOR UPDATE;
  PERFORM 1 FROM dasher.agent_run_events AS event
  WHERE event.organization_id = v_organization_id
    AND event.dashboard_id = p_dashboard_id
  ORDER BY pg_catalog.uuid_send(event.run_id), event.event_sequence
  FOR UPDATE OF event;
  PERFORM 1 FROM dasher.agent_run_checkpoints AS checkpoint
  WHERE checkpoint.organization_id = v_organization_id
    AND checkpoint.dashboard_id = p_dashboard_id
  ORDER BY pg_catalog.uuid_send(checkpoint.run_id), checkpoint.checkpoint_revision
  FOR UPDATE OF checkpoint;
  PERFORM 1 FROM dasher.agent_run_budget_counters AS counter
  WHERE counter.organization_id = v_organization_id
    AND counter.dashboard_id = p_dashboard_id
  ORDER BY pg_catalog.uuid_send(counter.run_id), counter.partition, counter.vector_field
  FOR UPDATE OF counter;
  PERFORM 1 FROM dasher.agent_run_attempts AS attempt
  WHERE attempt.organization_id = v_organization_id
    AND attempt.dashboard_id = p_dashboard_id
  ORDER BY pg_catalog.uuid_send(attempt.run_id), pg_catalog.uuid_send(attempt.attempt_id)
  FOR UPDATE OF attempt;
  PERFORM 1 FROM dasher.dashboard_cleanup_attempts AS cleanup_attempt
  WHERE cleanup_attempt.organization_id = v_organization_id
    AND cleanup_attempt.dashboard_id = p_dashboard_id
  ORDER BY cleanup_attempt.started_at, cleanup_attempt.cleanup_attempt_id
  FOR UPDATE OF cleanup_attempt;
  PERFORM 1 FROM dasher.dashboard_agent_drain_proofs AS proof
  WHERE proof.organization_id = v_organization_id
    AND proof.dashboard_id = p_dashboard_id
  ORDER BY pg_catalog.uuid_send(proof.proof_id)
  FOR UPDATE OF proof;
  PERFORM 1 FROM dasher.dashboard_agent_drain_proof_consumptions AS consumption
  WHERE consumption.organization_id = v_organization_id
    AND consumption.dashboard_id = p_dashboard_id
  ORDER BY pg_catalog.uuid_send(consumption.proof_id)
  FOR UPDATE OF consumption;
  SELECT proof.* INTO v_existing
  FROM dasher.dashboard_agent_run_age_out_proofs AS proof
  WHERE proof.organization_id = v_organization_id
    AND proof.dashboard_id = p_dashboard_id
    AND proof.lifecycle_revision = p_expected_lifecycle_revision
  FOR UPDATE OF proof;

  v_source_sha := dasher_private.recompute_age_out_source_proof_v1(
    v_organization_id, p_dashboard_id
  );
  IF v_source_sha IS NULL OR v_source_sha <> p_tombstone_backup_source_proof_sha256 THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;

  IF v_existing.age_out_operation_id IS NOT NULL THEN
    IF v_existing.age_out_operation_id <> p_operation_and_audit_id
      OR v_existing.source_purge_proof_sha256 <> v_source_sha
      OR v_existing.backup_deletion_proof_sha256 <> v_ledger.proof_sha256
      OR v_existing.retention_principal_id <> v_principal_id
      OR v_existing.retention_principal_revision <> v_principal_revision
      OR v_existing.age_out_proof_sha256 <>
        dasher_private.recompute_age_out_proof_v1(
          v_organization_id, p_dashboard_id
        )
      OR NOT EXISTS (
        SELECT 1 FROM dasher.audit_events AS audit
        WHERE audit.audit_event_id = p_operation_and_audit_id
          AND audit.organization_id = v_organization_id
          AND audit.action = 'dashboard.agent_run_metadata_aged_out'
          AND audit.target_type = 'dashboard'
          AND audit.target_id = p_dashboard_id
          AND audit.outcome = 'succeeded'
          AND audit.content_sha256 = v_existing.age_out_proof_sha256
      )
    THEN
      RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
    END IF;
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM dasher.audit_events AS audit
    WHERE audit.audit_event_id = p_operation_and_audit_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;
  IF NOT dasher_private.verify_phase7_content_purge_fk_dag_v1(
    v_organization_id, p_dashboard_id
  ) OR EXISTS (
    SELECT 1 FROM dasher.agent_run_request_payloads
      WHERE organization_id = v_organization_id AND dashboard_id = p_dashboard_id
    UNION ALL SELECT 1 FROM dasher.agent_run_checkpoint_payloads
      WHERE organization_id = v_organization_id AND dashboard_id = p_dashboard_id
    UNION ALL SELECT 1 FROM dasher.agent_run_attempt_payloads
      WHERE organization_id = v_organization_id AND dashboard_id = p_dashboard_id
    UNION ALL SELECT 1 FROM dasher.agent_recorded_results
      WHERE organization_id = v_organization_id AND dashboard_id = p_dashboard_id
    UNION ALL SELECT 1 FROM dasher.field_catalog_snapshots
      WHERE organization_id = v_organization_id AND dashboard_id = p_dashboard_id
    UNION ALL SELECT 1 FROM dasher.field_catalog_entries
      WHERE organization_id = v_organization_id AND dashboard_id = p_dashboard_id
    UNION ALL SELECT 1 FROM dasher.metric_contract_versions
      WHERE organization_id = v_organization_id AND dashboard_id = p_dashboard_id
    UNION ALL SELECT 1 FROM dasher.calculation_graphs
      WHERE organization_id = v_organization_id AND dashboard_id = p_dashboard_id
    UNION ALL SELECT 1 FROM dasher.calculation_results
      WHERE organization_id = v_organization_id AND dashboard_id = p_dashboard_id
    UNION ALL SELECT 1 FROM dasher.agent_run_calculation_meters
      WHERE organization_id = v_organization_id AND dashboard_id = p_dashboard_id
    UNION ALL SELECT 1 FROM dasher.briefs
      WHERE organization_id = v_organization_id AND dashboard_id = p_dashboard_id
    UNION ALL SELECT 1 FROM dasher.run_abstentions
      WHERE organization_id = v_organization_id AND dashboard_id = p_dashboard_id
    UNION ALL SELECT 1 FROM dasher.candidate_comparison_bundles
      WHERE organization_id = v_organization_id AND dashboard_id = p_dashboard_id
    UNION ALL SELECT 1 FROM dasher.candidate_comparison_bundle_evidence
      WHERE organization_id = v_organization_id AND dashboard_id = p_dashboard_id
    UNION ALL SELECT 1 FROM dasher.agent_candidates
      WHERE organization_id = v_organization_id AND dashboard_id = p_dashboard_id
    UNION ALL SELECT 1 FROM dasher.agent_candidate_payloads
      WHERE organization_id = v_organization_id AND dashboard_id = p_dashboard_id
    UNION ALL SELECT 1 FROM dasher.agent_validation_findings
      WHERE organization_id = v_organization_id AND dashboard_id = p_dashboard_id
    UNION ALL SELECT 1 FROM dasher.claims
      WHERE organization_id = v_organization_id AND dashboard_id = p_dashboard_id
    UNION ALL SELECT 1 FROM dasher.claim_evidence
      WHERE organization_id = v_organization_id AND dashboard_id = p_dashboard_id
    UNION ALL SELECT 1 FROM dasher.candidate_evidence_manifests
      WHERE organization_id = v_organization_id AND dashboard_id = p_dashboard_id
    LIMIT 1
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;

  SELECT pg_catalog.count(*) INTO v_runs
  FROM dasher.agent_runs AS run
  WHERE run.organization_id = v_organization_id
    AND run.dashboard_id = p_dashboard_id;
  v_chain_preimage :=
    pg_catalog.convert_to('dasher.agent-run-retained-chain-set.v1', 'UTF8')
    || pg_catalog.decode('00', 'hex')
    || pg_catalog.uuid_send(v_organization_id)
    || pg_catalog.uuid_send(p_dashboard_id)
    || pg_catalog.int8send(p_expected_lifecycle_revision)
    || pg_catalog.int8send(v_runs);
  v_events := 0;
  FOR v_run IN
    SELECT run.* FROM dasher.agent_runs AS run
    WHERE run.organization_id = v_organization_id
      AND run.dashboard_id = p_dashboard_id
    ORDER BY pg_catalog.uuid_send(run.run_id)
  LOOP
    IF v_run.state NOT IN (
        'rejected','cancelled','expired','failed','approval_required'
      )
      OR ROW(
        v_run.lease_token_sha256, v_run.lease_owner_principal_id,
        v_run.lease_owner_principal_revision, v_run.lease_expires_at
      ) IS DISTINCT FROM ROW(NULL::bytea,NULL::uuid,NULL::bigint,NULL::timestamptz)
      OR ROW(
        v_run.request_payload_id, v_run.candidate_set_sha256,
        v_run.terminal_reason_sha256, v_run.selected_candidate_id,
        v_run.consumed_replay_sequence, v_run.consumed_replay_sha256,
        v_run.terminal_claim_input_sha256, v_run.terminal_operation_sha256
      ) IS DISTINCT FROM ROW(
        NULL::uuid,NULL::bytea,NULL::bytea,NULL::uuid,
        NULL::bigint,NULL::bytea,NULL::bytea,NULL::bytea
      )
      OR v_run.current_event_sequence < 1
      OR pg_catalog.octet_length(v_run.current_event_sha256) <> 32
    THEN
      RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
    END IF;
    v_chain_preimage := v_chain_preimage
      || pg_catalog.uuid_send(v_run.run_id)
      || pg_catalog.int8send(v_run.current_event_sequence)
      || pg_catalog.int4send(pg_catalog.octet_length(
        v_run.current_event_sha256
      )) || v_run.current_event_sha256;
    v_event_sum := v_event_sum + v_run.current_event_sequence::numeric;
    IF v_event_sum > 9223372036854775807::numeric THEN
      RAISE EXCEPTION USING ERRCODE = '22003', MESSAGE = 'dasher_invalid';
    END IF;
    v_expected_event_sequence := 1;
    v_prior_event_sha := NULL;
    FOR v_event IN
      SELECT event.* FROM dasher.agent_run_events AS event
      WHERE event.organization_id = v_organization_id
        AND event.dashboard_id = p_dashboard_id
        AND event.run_id = v_run.run_id
      ORDER BY event.event_sequence
    LOOP
      IF v_event.event_sequence <> v_expected_event_sequence
        OR v_event.prior_event_sequence IS DISTINCT FROM (CASE
          WHEN v_expected_event_sequence = 1 THEN NULL::bigint
          ELSE v_expected_event_sequence - 1 END)
        OR v_event.prior_event_sha256 IS DISTINCT FROM v_prior_event_sha
        OR pg_catalog.octet_length(v_event.event_sha256) <> 32
        OR ROW(
          v_event.event_payload_id, v_event.claim_input_sha256,
          v_event.claim_result_sha256, v_event.claim_result_attempt_token,
          v_event.claim_result_input_sha256
        ) IS DISTINCT FROM ROW(
          NULL::uuid,NULL::bytea,NULL::bytea,NULL::bytea,NULL::bytea
        )
      THEN
        RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
      END IF;
      v_prior_event_sha := v_event.event_sha256;
      v_expected_event_sequence := v_expected_event_sequence + 1;
      v_events := v_events + 1;
    END LOOP;
    IF v_expected_event_sequence - 1 <> v_run.current_event_sequence
      OR v_prior_event_sha <> v_run.current_event_sha256
    THEN
      RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
    END IF;
  END LOOP;
  IF v_events <> v_event_sum::bigint THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;
  v_chain_sha := pg_catalog.sha256(v_chain_preimage);
  IF v_chain_sha <> dasher_private.recompute_retained_chain_set_v1(
    v_organization_id, p_dashboard_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;

  IF EXISTS (
    SELECT 1 FROM dasher.agent_run_checkpoints AS checkpoint
    WHERE checkpoint.organization_id = v_organization_id
      AND checkpoint.dashboard_id = p_dashboard_id
      AND ROW(checkpoint.state_sha256, checkpoint.checkpoint_payload_id)
        IS DISTINCT FROM ROW(NULL::bytea,NULL::uuid)
  ) OR EXISTS (
    SELECT 1 FROM dasher.agent_run_attempts AS attempt
    WHERE attempt.organization_id = v_organization_id
      AND attempt.dashboard_id = p_dashboard_id
      AND (
        ROW(attempt.request_payload_id, attempt.result_payload_id,
          attempt.terminal_reason_sha256)
          IS DISTINCT FROM ROW(NULL::uuid,NULL::uuid,NULL::bytea)
        OR attempt.state NOT IN (
          'succeeded','refused_charged','failed_charged','released_pre_dispatch',
          'released_takeover','cancelled_released','cancelled_charged',
          'indeterminate_quarantined'
        )
        OR attempt.outstanding_vector IS DISTINCT FROM ROW(
          0,0,0,0,0,0,0,0,0,0,0,0,0,0
        )::dasher_run_api.attempt_resource_vector
      )
  ) OR EXISTS (
    SELECT 1 FROM dasher.agent_run_budget_counters AS counter
    WHERE counter.organization_id = v_organization_id
      AND counter.dashboard_id = p_dashboard_id
      AND (
        counter.limit_units < 0 OR counter.reserved_units < 0
        OR counter.used_units < 0 OR counter.released_units < 0
        OR counter.reserved_units <> counter.used_units + counter.released_units
        OR counter.reserved_units > counter.limit_units
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;
  SELECT pg_catalog.count(*) INTO v_checkpoints
  FROM dasher.agent_run_checkpoints
  WHERE organization_id = v_organization_id AND dashboard_id = p_dashboard_id;
  SELECT pg_catalog.count(*) INTO v_attempts FROM dasher.agent_run_attempts
  WHERE organization_id = v_organization_id AND dashboard_id = p_dashboard_id;
  SELECT pg_catalog.count(*) INTO v_counters FROM dasher.agent_run_budget_counters
  WHERE organization_id = v_organization_id AND dashboard_id = p_dashboard_id;
  SELECT pg_catalog.count(*) INTO v_consumptions
  FROM dasher.dashboard_agent_drain_proof_consumptions
  WHERE organization_id = v_organization_id AND dashboard_id = p_dashboard_id;
  SELECT pg_catalog.count(*) INTO v_proofs FROM dasher.dashboard_agent_drain_proofs
  WHERE organization_id = v_organization_id AND dashboard_id = p_dashboard_id;

  v_age_sha := pg_catalog.sha256(
    pg_catalog.convert_to('dasher.agent-run-age-out-proof.v1', 'UTF8')
    || pg_catalog.decode('00', 'hex')
    || pg_catalog.int4send(pg_catalog.octet_length(v_source_sha))
    || v_source_sha
    || pg_catalog.int8send(v_runs) || pg_catalog.int8send(v_runs)
    || pg_catalog.int8send(v_events) || pg_catalog.int8send(v_checkpoints)
    || pg_catalog.int8send(v_attempts) || pg_catalog.int8send(v_counters)
    || pg_catalog.int8send(v_consumptions) || pg_catalog.int8send(v_proofs)
    || pg_catalog.int4send(pg_catalog.octet_length(v_chain_sha))
    || v_chain_sha || pg_catalog.int8send(v_events)
    || pg_catalog.int8send((
      extract(epoch FROM v_now) * 1000000
    )::bigint)
    || pg_catalog.uuid_send(v_principal_id)
    || pg_catalog.int8send(v_principal_revision)
  );
  INSERT INTO dasher.dashboard_agent_run_age_out_proofs (
    organization_id, dashboard_id, age_out_operation_id, lifecycle_revision,
    source_purge_proof_sha256, backup_deletion_proof_sha256,
    eligible_run_count, deleted_run_count, deleted_event_count,
    deleted_checkpoint_count, deleted_attempt_count, deleted_counter_count,
    deleted_drain_proof_consumption_count, deleted_drain_proof_count,
    retained_chain_head_sha256, retained_event_count, deleted_at,
    retention_principal_id, retention_principal_revision, age_out_proof_sha256
  ) VALUES (
    v_organization_id, p_dashboard_id, p_operation_and_audit_id,
    p_expected_lifecycle_revision, v_source_sha, v_ledger.proof_sha256,
    v_runs, v_runs, v_events, v_checkpoints, v_attempts, v_counters,
    v_consumptions, v_proofs, v_chain_sha, v_events, v_now,
    v_principal_id, v_principal_revision, v_age_sha
  );
  BEGIN
    INSERT INTO dasher.audit_events (
      audit_event_id, organization_id, occurred_at, actor_kind, actor_user_id,
      actor_service, authority_revision, request_id, job_id, action, target_type,
      target_id, outcome, content_sha256, source_ref, provider,
      credential_version, usage_units, cost_minor_units, deployment_revision
    ) VALUES (
      p_operation_and_audit_id, v_organization_id, v_now, 'service', NULL,
      session_user::text, v_principal_revision,
      current_setting('dasher.retention_request_id', true)::uuid, NULL,
      'dashboard.agent_run_metadata_aged_out', 'dashboard', p_dashboard_id,
      'succeeded', v_age_sha, NULL, NULL, NULL, NULL, NULL, p_deployment_revision
    );
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END;

  SELECT proof.* INTO STRICT v_existing
  FROM dasher.dashboard_agent_run_age_out_proofs AS proof
  WHERE proof.organization_id = v_organization_id
    AND proof.dashboard_id = p_dashboard_id
    AND proof.lifecycle_revision = p_expected_lifecycle_revision;
  IF v_existing.age_out_proof_sha256 <> v_age_sha
    OR v_existing.age_out_proof_sha256 <>
      dasher_private.recompute_age_out_proof_v1(
        v_organization_id, p_dashboard_id
      )
    OR v_existing.retained_chain_head_sha256 <>
      dasher_private.recompute_retained_chain_set_v1(
        v_organization_id, p_dashboard_id
      )
    OR (SELECT pg_catalog.count(*) FROM dasher.agent_run_events AS event
        WHERE event.organization_id = v_organization_id
          AND event.dashboard_id = p_dashboard_id) <> v_existing.retained_event_count
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;
  v_recomputed_events := 0;
  FOR v_run IN
    SELECT run.* FROM dasher.agent_runs AS run
    WHERE run.organization_id = v_organization_id
      AND run.dashboard_id = p_dashboard_id
    ORDER BY pg_catalog.uuid_send(run.run_id)
  LOOP
    v_expected_event_sequence := 1;
    v_prior_event_sha := NULL;
    FOR v_event IN
      SELECT event.* FROM dasher.agent_run_events AS event
      WHERE event.organization_id = v_organization_id
        AND event.dashboard_id = p_dashboard_id
        AND event.run_id = v_run.run_id
      ORDER BY event.event_sequence
    LOOP
      IF v_event.event_sequence <> v_expected_event_sequence
        OR v_event.prior_event_sequence IS DISTINCT FROM (CASE
          WHEN v_expected_event_sequence = 1 THEN NULL::bigint
          ELSE v_expected_event_sequence - 1 END)
        OR v_event.prior_event_sha256 IS DISTINCT FROM v_prior_event_sha
      THEN
        RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
      END IF;
      v_prior_event_sha := v_event.event_sha256;
      v_expected_event_sequence := v_expected_event_sequence + 1;
      v_recomputed_events := v_recomputed_events + 1;
    END LOOP;
    IF v_expected_event_sequence - 1 <> v_run.current_event_sequence
      OR v_prior_event_sha <> v_run.current_event_sha256
    THEN
      RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
    END IF;
  END LOOP;
  IF v_recomputed_events <> v_existing.retained_event_count THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;

  DELETE FROM dasher.agent_run_attempts
  WHERE organization_id = v_organization_id AND dashboard_id = p_dashboard_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  IF v_deleted <> v_existing.deleted_attempt_count THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;
  DELETE FROM dasher.agent_run_checkpoints
  WHERE organization_id = v_organization_id AND dashboard_id = p_dashboard_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  IF v_deleted <> v_existing.deleted_checkpoint_count THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;
  DELETE FROM dasher.agent_run_budget_counters
  WHERE organization_id = v_organization_id AND dashboard_id = p_dashboard_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  IF v_deleted <> v_existing.deleted_counter_count THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;
  DELETE FROM dasher.agent_run_events
  WHERE organization_id = v_organization_id AND dashboard_id = p_dashboard_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  IF v_deleted <> v_existing.deleted_event_count
    OR v_deleted <> v_existing.retained_event_count
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;
  DELETE FROM dasher.dashboard_agent_drain_proof_consumptions
  WHERE organization_id = v_organization_id AND dashboard_id = p_dashboard_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  IF v_deleted <> v_existing.deleted_drain_proof_consumption_count THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;
  DELETE FROM dasher.dashboard_agent_drain_proofs
  WHERE organization_id = v_organization_id AND dashboard_id = p_dashboard_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  IF v_deleted <> v_existing.deleted_drain_proof_count THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;
  DELETE FROM dasher.agent_runs
  WHERE organization_id = v_organization_id AND dashboard_id = p_dashboard_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  IF v_deleted <> v_existing.deleted_run_count
    OR v_existing.eligible_run_count <> v_existing.deleted_run_count
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;
END
$function$;

-- Part 7 - dasher_api.request_agent_run audit-event-id collision
-- normalization.
--
-- dasher.audit_events.audit_event_id is a global primary key. This entry point
-- writes it from the caller-supplied p_audit_event_id and carries no probe on
-- it at all: the only thing frozen 0007 checks about that parameter is that it
-- is non-null and is not the same uuid as the request id. Idempotency is
-- carried elsewhere, by p_run_request_id and p_idempotency_sha256, both of
-- which are scoped to this organization and dashboard. So an audit id already
-- spent by an audit row in a different organization - or by any other action
-- on any other target - is invisible to every guard here, the call proceeds
-- through its whole write path, and the audit INSERT at the end raises a bare
-- 23505 carrying the constraint name of dasher.audit_events.
--
-- That is the outcome this series does not permit an entry point to emit for a
-- duplicate non-idempotent operation: it must normalize to P1002 /
-- dasher_conflict without exposing SQL, constraints, or existence detail. This
-- one is reachable by an ordinary tenant caller through dasher_api, which is
-- the surface where leaking a constraint name matters most - the raw 23505
-- message also confirms that some other row already holds that uuid, which is
-- a cross-tenant existence oracle over a caller-chosen identifier.
--
-- The re-issued body below is byte-identical to the frozen 0007 definition
-- apart from CREATE FUNCTION becoming CREATE OR REPLACE FUNCTION, and the
-- audit INSERT being wrapped in the same block Part 6 uses on the age-out,
-- whose only handler turns unique_violation into the same P1002 /
-- dasher_conflict this function already raises on every other conflict.
-- Signature, SECURITY DEFINER, search path, volatility, every declaration,
-- every advisory lock, every FOR UPDATE row mark, every policy-chain probe,
-- every budget check, every preimage and every other RAISE are preserved.
--
-- Only the single INSERT statement is inside the block. Every row mark this
-- function takes - on the policy revision, the membership, the lifecycle
-- policy, the dashboard, the snapshot and the budget counters - was taken
-- earlier and stays in the outer transaction, so none of them is released by
-- the subtransaction the block opens. The nested block frozen 0007 already
-- carries around its own uuid-parse guard is untouched and is unrelated. The
-- handler re-raises rather than swallowing, so the block's subtransaction
-- unwinds the audit INSERT and the propagating exception unwinds everything
-- the call had already done - the run row, both event rows, the payload, the
-- budget counters - leaving the organization exactly as it was before the
-- call. This normalizes an error; it does not widen a read and it does not
-- change what is written.

CREATE OR REPLACE FUNCTION dasher_api.request_agent_run(
  p_dashboard_id uuid,
  p_input_snapshot_id uuid,
  p_run_request_id uuid,
  p_purpose text,
  p_expected_lifecycle_revision bigint,
  p_expected_input_sha256 bytea,
  p_idempotency_sha256 bytea,
  p_audit_event_id uuid,
  p_current_csrf_key_version smallint,
  p_current_csrf_digest bytea,
  p_deployment_revision text,
  p_replay_source_run_id uuid
)
RETURNS dasher_api.agent_run_request_result
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_organization_id uuid := dasher_private.context_organization_id();
  v_user_id uuid := dasher_private.context_user_id();
  v_membership_id uuid := dasher_private.context_membership_id();
  v_authority_revision bigint := dasher_private.context_authority_revision();
  v_request_id uuid := dasher_private.context_request_id();
  v_now timestamptz := pg_catalog.statement_timestamp();
  v_policy dasher.agent_run_policy_revisions%ROWTYPE;
  v_source dasher.source_snapshots%ROWTYPE;
  v_catalog dasher.field_catalog_snapshots%ROWTYPE;
  v_replay_source dasher.agent_runs%ROWTYPE;
  v_replay_result_count bigint;
  v_replay_head_sha bytea;
  v_replay_bundle dasher.candidate_comparison_bundles%ROWTYPE;
  v_replay_brief dasher.briefs%ROWTYPE;
  v_existing dasher.agent_runs%ROWTYPE;
  v_existing_payload dasher.agent_run_request_payloads%ROWTYPE;
  v_existing_found boolean := false;
  v_run_id uuid := dasher_private.uuid_v8_from_sha256_v1(pg_catalog.convert_to(pg_catalog.clock_timestamp()::text || '|' || pg_catalog.txid_current()::text || '|' || pg_catalog.random()::text, 'UTF8'));
  v_request_payload_id uuid := dasher_private.uuid_v8_from_sha256_v1(pg_catalog.convert_to(pg_catalog.clock_timestamp()::text || '|' || pg_catalog.txid_current()::text || '|' || pg_catalog.random()::text, 'UTF8'));
  v_event_id uuid := dasher_private.uuid_v8_from_sha256_v1(pg_catalog.convert_to(pg_catalog.clock_timestamp()::text || '|' || pg_catalog.txid_current()::text || '|' || pg_catalog.random()::text, 'UTF8'));
  v_event_payload_id uuid := dasher_private.uuid_v8_from_sha256_v1(pg_catalog.convert_to(pg_catalog.clock_timestamp()::text || '|' || pg_catalog.txid_current()::text || '|' || pg_catalog.random()::text, 'UTF8'));
  v_nonce bytea := pg_catalog.uuid_send(dasher_private.uuid_v8_from_sha256_v1(pg_catalog.convert_to(pg_catalog.clock_timestamp()::text || '|' || pg_catalog.txid_current()::text || '|' || pg_catalog.random()::text, 'UTF8')))
    || pg_catalog.uuid_send(dasher_private.uuid_v8_from_sha256_v1(pg_catalog.convert_to(pg_catalog.clock_timestamp()::text || '|' || pg_catalog.txid_current()::text || '|' || pg_catalog.random()::text, 'UTF8')));
  v_request_bytes bytea;
  v_request_semantic_sha bytea;
  v_request_sha bytea;
  v_event_payload_bytes bytea;
  v_event_semantic_sha bytea;
  v_event_payload_sha bytea;
  v_event_sha bytea;
  v_computed_idempotency bytea;
  v_generation dasher_run_api.attempt_resource_vector := ROW(
    4, 2, 1, 0, 1, 20000, 8000, 8000, 20000, 8000,
    24000, 36000, 32000, 120000
  )::dasher_run_api.attempt_resource_vector;
  v_review dasher_run_api.attempt_resource_vector := ROW(
    1, 0, 0, 1, 0, 5000, 2000, 2000, 5000, 2000,
    6000, 9000, 8000, 30000
  )::dasher_run_api.attempt_resource_vector;
  v_result dasher_api.agent_run_request_result;
  v_request_json jsonb;
  v_source_body jsonb;
  v_field_catalog jsonb;
  v_rebuilt_field_catalog jsonb;
  v_metric_contract_set jsonb;
  v_event_body jsonb;
  v_compact_event_body text := '';
  v_input_row record;
  v_stable_field record;
  v_stable_value jsonb;
  v_sort_key bytea;
  v_prior_sort_key bytea;
  v_prior_row_id uuid;
  v_expected_row_id uuid;
  v_decimal_unsigned numeric;
  v_decimal_byte integer;
  v_decimal_index integer;
BEGIN
  IF p_purpose NOT IN ('suggest', 'replay')
    OR (p_purpose = 'suggest') <> (p_replay_source_run_id IS NULL)
    OR p_expected_lifecycle_revision < 1
    OR pg_catalog.octet_length(p_expected_input_sha256) <> 32
    OR pg_catalog.octet_length(p_idempotency_sha256) <> 32
    OR pg_catalog.octet_length(p_current_csrf_digest) <> 32
    OR p_audit_event_id IS NULL OR p_audit_event_id = v_request_id
    OR p_run_request_id IS NULL OR p_input_snapshot_id IS NULL
    OR p_deployment_revision IS NULL
    OR p_deployment_revision <> pg_catalog.btrim(p_deployment_revision)
    OR pg_catalog.char_length(p_deployment_revision) NOT BETWEEN 1 AND 64
    OR NOT dasher_private.context_allows(v_organization_id, 'editor')
    OR NOT dasher_private.context_csrf_allows(
      p_current_csrf_key_version, p_current_csrf_digest
    )
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;

  PERFORM pg_catalog.set_config(
    'dasher.security_capability', 'request_agent_run', true
  );
  PERFORM pg_catalog.set_config(
    'dasher.security_dashboard_id', p_dashboard_id::text, true
  );
  PERFORM pg_catalog.set_config('dasher.security_phase', 'authorized', true);

  PERFORM pg_catalog.pg_advisory_xact_lock(724372, 20260804);
  INSERT INTO dasher.agent_run_policy_revisions (
    policy_revision, previous_policy_revision, previous_policy_sha256,
    policy_sha256, enabled, adapter_id, model_id, price_book_revision,
    input_token_micros, output_token_micros, generation_limit_vector,
    review_limit_vector, active_organization_run_limit,
    active_dashboard_run_limit, approval_required_dashboard_limit,
    provider_concurrency_limit, tool_attempt_limit, retry_limit,
    planner_instructions_sha256, generator_instructions_sha256,
    specialist_instructions_sha256, repair_instructions_sha256,
    reviewer_instructions_sha256, created_at
  )
  SELECT 1, NULL, NULL,
    pg_catalog.sha256(
      pg_catalog.convert_to('dasher.agent-run-policy.v1', 'UTF8')
      || pg_catalog.decode('00', 'hex')
      || pg_catalog.int8send(1)
      || pg_catalog.decode('00', 'hex')
      || pg_catalog.decode('00', 'hex')
      || pg_catalog.decode('01', 'hex')
      || pg_catalog.int4send(pg_catalog.octet_length('fake-provider-v1'))
      || pg_catalog.convert_to('fake-provider-v1', 'UTF8')
      || pg_catalog.int4send(pg_catalog.octet_length('fake-model-v1'))
      || pg_catalog.convert_to('fake-model-v1', 'UTF8')
      || pg_catalog.int4send(pg_catalog.octet_length('fake-price-book-v1'))
      || pg_catalog.convert_to('fake-price-book-v1', 'UTF8')
      || pg_catalog.int8send(2) || pg_catalog.int8send(4)
      || pg_catalog.int8send(4) || pg_catalog.int8send(2)
      || pg_catalog.int8send(1) || pg_catalog.int8send(0)
      || pg_catalog.int8send(1) || pg_catalog.int8send(20000)
      || pg_catalog.int8send(8000) || pg_catalog.int8send(8000)
      || pg_catalog.int8send(20000) || pg_catalog.int8send(8000)
      || pg_catalog.int8send(24000) || pg_catalog.int8send(36000)
      || pg_catalog.int8send(32000) || pg_catalog.int8send(120000)
      || pg_catalog.int8send(1) || pg_catalog.int8send(0)
      || pg_catalog.int8send(0) || pg_catalog.int8send(1)
      || pg_catalog.int8send(0) || pg_catalog.int8send(5000)
      || pg_catalog.int8send(2000) || pg_catalog.int8send(2000)
      || pg_catalog.int8send(5000) || pg_catalog.int8send(2000)
      || pg_catalog.int8send(6000) || pg_catalog.int8send(9000)
      || pg_catalog.int8send(8000) || pg_catalog.int8send(30000)
      || pg_catalog.int8send(2) || pg_catalog.int8send(1)
      || pg_catalog.int8send(2) || pg_catalog.int8send(1)
      || pg_catalog.int8send(0) || pg_catalog.int8send(1)
      || pg_catalog.int4send(32) || pg_catalog.decode(
        'd57dc1caa47bb25cfe39dd8d44f22167f887414c23fa56a9838947605e87b269',
        'hex'
      )
      || pg_catalog.int4send(32) || pg_catalog.decode(
        '8d302cfdc12d2688ac685c587ba12dcffb533adabd32ac8dd2371e1eec300021',
        'hex'
      )
      || pg_catalog.int4send(32) || pg_catalog.decode(
        'a7607000dbd2cd782f0fc42e621fe55299c9507e458015d3ca7671e80e1df714',
        'hex'
      )
      || pg_catalog.int4send(32) || pg_catalog.decode(
        'da21c80354847f46eacb65d09361eeb84abff4b1d41fa31804b16911a9b19026',
        'hex'
      )
      || pg_catalog.int4send(32) || pg_catalog.decode(
        '13c81cc91b6ca0a3d36b13b61c2222303e93e40d239bcbb8014a89b473b22751',
        'hex'
      )
    ), TRUE, 'fake-provider-v1', 'fake-model-v1', 'fake-price-book-v1',
    2, 4, v_generation, v_review, 2, 1, 2, 1, 0, 1,
    pg_catalog.decode(
      'd57dc1caa47bb25cfe39dd8d44f22167f887414c23fa56a9838947605e87b269',
      'hex'
    ),
    pg_catalog.decode(
      '8d302cfdc12d2688ac685c587ba12dcffb533adabd32ac8dd2371e1eec300021',
      'hex'
    ),
    pg_catalog.decode(
      'a7607000dbd2cd782f0fc42e621fe55299c9507e458015d3ca7671e80e1df714',
      'hex'
    ),
    pg_catalog.decode(
      'da21c80354847f46eacb65d09361eeb84abff4b1d41fa31804b16911a9b19026',
      'hex'
    ),
    pg_catalog.decode(
      '13c81cc91b6ca0a3d36b13b61c2222303e93e40d239bcbb8014a89b473b22751',
      'hex'
    ),
    v_now
  WHERE NOT EXISTS (SELECT 1 FROM dasher.agent_run_policy_revisions);

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'dasher:organization:v1|' || v_organization_id::text, 0
    )
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'dasher:agent-run-request:v1|' || v_organization_id::text
        || '|' || p_run_request_id::text,
      0
    )
  );
  PERFORM 1 FROM dasher.memberships AS membership
  WHERE membership.organization_id = v_organization_id
    AND membership.membership_id = v_membership_id
    AND membership.user_id = v_user_id
    AND membership.authority_revision = v_authority_revision
    AND membership.state = 'active'
    AND membership.role IN ('editor', 'admin')
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;

  PERFORM lifecycle_policy.policy_revision
  FROM dasher.dashboard_lifecycle_policies AS lifecycle_policy
  WHERE lifecycle_policy.organization_id = v_organization_id
    AND lifecycle_policy.policy_revision >= 1
    AND lifecycle_policy.retention_policy_revision >= 1
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  SELECT policy.* INTO v_policy
  FROM dasher.agent_run_policy_revisions AS policy
  ORDER BY policy.policy_revision DESC
  LIMIT 1
  FOR UPDATE;
  IF NOT FOUND OR NOT v_policy.enabled
    OR NOT dasher_private.validate_agent_run_policy_chain_v1()
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  PERFORM 1 FROM dasher.dashboards AS dashboard
  WHERE dashboard.organization_id = v_organization_id
    AND dashboard.dashboard_id = p_dashboard_id
    AND dashboard.lifecycle_revision = p_expected_lifecycle_revision
    AND dashboard.lifecycle_state IN ('draft', 'active')
    AND dashboard.access_revoked_at IS NULL
    AND dashboard.purged_at IS NULL
    AND NOT (
      dashboard.current_kind = 'disposable'
      AND dashboard.effective_expires_at IS NOT NULL
      AND v_now >= dashboard.effective_expires_at
    )
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  SELECT snapshot.* INTO v_source
  FROM dasher.source_snapshots AS snapshot
  WHERE snapshot.organization_id = v_organization_id
    AND snapshot.snapshot_id = p_input_snapshot_id
    AND snapshot.content_sha256 = p_expected_input_sha256
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  IF p_purpose = 'replay' THEN
    PERFORM pg_catalog.set_config(
      'dasher.run_principal_id', v_user_id::text, true
    );
    PERFORM pg_catalog.set_config(
      'dasher.run_principal_revision', v_authority_revision::text, true
    );
    PERFORM pg_catalog.set_config(
      'dasher.run_capability', 'replay_source_fence', true
    );
    PERFORM pg_catalog.set_config(
      'dasher.run_request_id', v_request_id::text, true
    );
    PERFORM pg_catalog.set_config(
      'dasher.run_organization_id', v_organization_id::text, true
    );
    PERFORM pg_catalog.set_config(
      'dasher.run_dashboard_id', p_dashboard_id::text, true
    );
    PERFORM pg_catalog.set_config(
      'dasher.run_id', p_replay_source_run_id::text, true
    );
    PERFORM pg_catalog.set_config(
      'dasher.run_membership_id', v_membership_id::text, true
    );
    PERFORM pg_catalog.set_config(
      'dasher.run_user_id', v_user_id::text, true
    );
    PERFORM pg_catalog.set_config(
      'dasher.run_authority_revision', v_authority_revision::text, true
    );
    PERFORM pg_catalog.set_config(
      'dasher.run_policy_revision', v_policy.policy_revision::text, true
    );
    PERFORM pg_catalog.set_config('dasher.run_phase', 'authorized', true);
    v_replay_source := dasher_private.replay_source_fence_v1(
      v_organization_id, p_replay_source_run_id
    );
    SELECT pg_catalog.count(*),
        (pg_catalog.array_agg(
          result.result_head_sha256 ORDER BY result.result_sequence DESC
        ))[1]
      INTO v_replay_result_count, v_replay_head_sha
    FROM dasher.agent_recorded_results AS result
    WHERE result.organization_id = v_replay_source.organization_id
      AND result.dashboard_id = v_replay_source.dashboard_id
      AND result.run_id = v_replay_source.run_id;
    SELECT bundle.* INTO STRICT v_replay_bundle
    FROM dasher.candidate_comparison_bundles AS bundle
    WHERE bundle.organization_id = v_replay_source.organization_id
      AND bundle.dashboard_id = v_replay_source.dashboard_id
      AND bundle.run_id = v_replay_source.run_id;
    SELECT brief.* INTO STRICT v_replay_brief
    FROM dasher.briefs AS brief
    WHERE brief.organization_id = v_replay_source.organization_id
      AND brief.dashboard_id = v_replay_source.dashboard_id
      AND brief.run_id = v_replay_source.run_id;
  END IF;

  v_computed_idempotency := pg_catalog.sha256(
    pg_catalog.convert_to(
      'dasher.agent-run-request-idempotency.v1', 'UTF8'
    ) || pg_catalog.decode('00', 'hex')
    || pg_catalog.uuid_send(p_dashboard_id)
    || pg_catalog.uuid_send(p_input_snapshot_id)
    || pg_catalog.uuid_send(p_run_request_id)
    || pg_catalog.int4send(pg_catalog.octet_length(p_purpose))
    || pg_catalog.convert_to(p_purpose, 'UTF8')
    || pg_catalog.int8send(p_expected_lifecycle_revision)
    || p_expected_input_sha256
    || CASE WHEN p_replay_source_run_id IS NULL
      THEN pg_catalog.decode('00', 'hex')
      ELSE pg_catalog.decode('01', 'hex')
        || pg_catalog.uuid_send(p_replay_source_run_id) END
    || pg_catalog.int4send(pg_catalog.octet_length(p_deployment_revision))
    || pg_catalog.convert_to(p_deployment_revision, 'UTF8')
  );
  IF v_computed_idempotency <> p_idempotency_sha256 THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;

  SELECT run.* INTO v_existing
  FROM dasher.agent_runs AS run
  WHERE run.organization_id = v_organization_id
    AND run.run_request_id = p_run_request_id
  FOR UPDATE;
  IF FOUND THEN
    v_existing_found := true;
    v_now := v_existing.requested_at;
  END IF;

  IF NOT v_existing_found AND (
    (
      SELECT pg_catalog.count(*)
      FROM dasher.agent_runs AS run
      WHERE run.organization_id = v_organization_id
        AND run.state IN (
          'requested', 'authorized', 'planning', 'generating',
          'validating', 'revising'
        )
    ) >= v_policy.active_organization_run_limit
    OR (
      SELECT pg_catalog.count(*)
      FROM dasher.agent_runs AS run
      WHERE run.organization_id = v_organization_id
        AND run.dashboard_id = p_dashboard_id
        AND run.state IN (
          'requested', 'authorized', 'planning', 'generating',
          'validating', 'revising'
        )
    ) >= v_policy.active_dashboard_run_limit
  )
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_limit';
  END IF;

  BEGIN
    v_source_body := pg_catalog.convert_from(
      v_source.canonical_bytes, 'UTF8'
    )::jsonb;
    IF v_source.source_kind <> 'synthetic_fixture'
      OR v_source.observed_at IS NULL
      OR v_source.retrieved_at IS NULL
      OR v_source.created_at IS NULL
      OR v_source.observed_at > v_source.retrieved_at
      OR v_source.retrieved_at > v_source.created_at
      OR dasher_private.canonical_jsonb_bytes_v1(
        pg_catalog.convert_from(v_source.canonical_bytes, 'UTF8')::jsonb
      ) IS DISTINCT FROM v_source.canonical_bytes
      OR pg_catalog.convert_from(v_source.canonical_bytes, 'UTF8')::jsonb
        ->>'schema' <> 'canonical-input-table-v1'
      OR pg_catalog.convert_from(v_source.canonical_bytes, 'UTF8')::jsonb
        ->>'input_snapshot_id' <> v_source.snapshot_id::text
      OR pg_catalog.jsonb_typeof(v_source_body) <> 'object'
      OR (SELECT pg_catalog.count(*)
          FROM pg_catalog.jsonb_object_keys(v_source_body)) <> 5
      OR NOT v_source_body ?& ARRAY[
        'schema','input_snapshot_id','row_count','fields','rows'
      ]
      OR v_source_body->>'row_count' !~ '^i64:(0|[1-9][0-9]{0,4})$'
      OR pg_catalog.substr(v_source_body->>'row_count', 5)::bigint <>
        pg_catalog.jsonb_array_length(v_source_body->'rows')
      OR pg_catalog.jsonb_array_length(v_source_body->'rows') > 10000
      OR pg_catalog.jsonb_array_length(v_source_body->'fields')
        NOT BETWEEN 1 AND 512
      OR (SELECT pg_catalog.count(*)
          FROM pg_catalog.jsonb_array_elements(v_source_body->'fields')
            AS field(value)
          WHERE field.value->'stable_key_ordinal' <> 'null'::jsonb) < 1
      OR EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_array_elements(v_source_body->'fields')
          WITH ORDINALITY AS field(value, ordinal)
        WHERE pg_catalog.jsonb_typeof(field.value) <> 'object'
          OR (SELECT pg_catalog.count(*)
              FROM pg_catalog.jsonb_object_keys(field.value)) <> 4
          OR NOT field.value ?& ARRAY[
            'field_id','scalar_type','nullable','stable_key_ordinal'
          ]
          OR field.value->>'field_id' <> (field.value->>'field_id')::uuid::text
          OR field.value->>'scalar_type' NOT IN (
            'boolean','integer','decimal','text','date','timestamp'
          )
          OR pg_catalog.jsonb_typeof(field.value->'nullable') <> 'boolean'
          OR (field.value->'stable_key_ordinal' <> 'null'::jsonb
            AND field.value->>'stable_key_ordinal' !~
              '^i64:(0|[1-9][0-9]*)$')
          OR EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_array_elements(v_source_body->'fields')
              WITH ORDINALITY AS prior(value, ordinal)
            WHERE prior.ordinal = field.ordinal - 1
              AND pg_catalog.uuid_send((prior.value->>'field_id')::uuid) >=
                pg_catalog.uuid_send((field.value->>'field_id')::uuid)
          )
      )
      OR EXISTS (
        SELECT 1
        FROM pg_catalog.generate_series(0, (
          SELECT pg_catalog.count(*)::integer - 1
          FROM pg_catalog.jsonb_array_elements(v_source_body->'fields')
            AS field(value)
          WHERE field.value->'stable_key_ordinal' <> 'null'::jsonb
        )) AS expected_ordinal
        WHERE 1 <> (
          SELECT pg_catalog.count(*)
          FROM pg_catalog.jsonb_array_elements(v_source_body->'fields')
            AS field(value)
          WHERE field.value->>'stable_key_ordinal' =
            'i64:' || expected_ordinal::text
        )
      )
      OR EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_array_elements(v_source_body->'rows')
          WITH ORDINALITY AS input_row(value, ordinal)
        WHERE pg_catalog.jsonb_typeof(input_row.value) <> 'object'
          OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(
              input_row.value
            )) <> 2
          OR NOT input_row.value ?& ARRAY['row_id','values']
          OR input_row.value->>'row_id' <>
            (input_row.value->>'row_id')::uuid::text
          OR pg_catalog.get_byte(
            pg_catalog.uuid_send((input_row.value->>'row_id')::uuid), 6
          ) >> 4 <> 8
          OR pg_catalog.jsonb_array_length(input_row.value->'values') <>
            pg_catalog.jsonb_array_length(v_source_body->'fields')
          OR EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_array_elements(input_row.value->'values')
              WITH ORDINALITY AS input_value(value, ordinal)
            JOIN pg_catalog.jsonb_array_elements(v_source_body->'fields')
              WITH ORDINALITY AS field(value, ordinal) USING (ordinal)
            WHERE pg_catalog.jsonb_typeof(input_value.value) <> 'object'
              OR (SELECT pg_catalog.count(*)
                  FROM pg_catalog.jsonb_object_keys(input_value.value)) <> 4
              OR NOT input_value.value ?& ARRAY[
                'field_id','state','type','value'
              ]
              OR input_value.value->>'field_id' <> field.value->>'field_id'
              OR input_value.value->>'type' <> field.value->>'scalar_type'
              OR input_value.value->>'state' NOT IN (
                'present','null','missing','unavailable'
              )
              OR (input_value.value->>'state' = 'null'
                AND field.value->'nullable' <> 'true'::jsonb)
              OR ((input_value.value->>'state' <> 'present') <>
                (input_value.value->'value' = 'null'::jsonb))
              OR (field.value->'stable_key_ordinal' <> 'null'::jsonb
                AND input_value.value->>'state' <> 'present')
              OR (input_value.value->>'state' = 'present' AND CASE
                input_value.value->>'type'
                WHEN 'boolean' THEN pg_catalog.jsonb_typeof(
                  input_value.value->'value'
                ) <> 'boolean'
                WHEN 'integer' THEN input_value.value->>'value' !~
                  '^i64:(0|-?[1-9][0-9]*)$'
                WHEN 'decimal' THEN
                  pg_catalog.jsonb_typeof(input_value.value->'value') <>
                    'object'
                  OR (SELECT pg_catalog.count(*)
                      FROM pg_catalog.jsonb_object_keys(
                        input_value.value->'value'
                      )) <> 2
                  OR input_value.value#>>'{value,coefficient}' !~
                    '^(0|-?[1-9][0-9]{0,37})$'
                  OR input_value.value#>>'{value,scale}' !~
                    '^i64:([0-9]|1[0-8])$'
                  OR (input_value.value#>>'{value,coefficient}' = '0'
                    AND input_value.value#>>'{value,scale}' <> 'i64:0')
                  OR (input_value.value#>>'{value,scale}' <> 'i64:0'
                    AND input_value.value#>>'{value,coefficient}' ~ '0$')
                WHEN 'text' THEN pg_catalog.jsonb_typeof(
                  input_value.value->'value'
                ) <> 'string'
                WHEN 'date' THEN input_value.value->>'value' <>
                  (input_value.value->>'value')::date::text
                ELSE input_value.value->>'value' <> pg_catalog.to_char(
                  (input_value.value->>'value')::timestamptz AT TIME ZONE 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
                ) END)
          )
      )
      OR v_source.content_sha256 <> pg_catalog.sha256(
        pg_catalog.convert_to('dasher.canonical-input-table.v1', 'UTF8')
        || pg_catalog.decode('00', 'hex')
        || pg_catalog.int4send(pg_catalog.octet_length(v_source.canonical_bytes))
        || v_source.canonical_bytes
      )
    THEN
      RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
    END IF;
    v_prior_sort_key := NULL;
    v_prior_row_id := NULL;
    FOR v_input_row IN
      SELECT input_row.value, input_row.ordinal
      FROM pg_catalog.jsonb_array_elements(v_source_body->'rows')
        WITH ORDINALITY AS input_row(value, ordinal)
      ORDER BY input_row.ordinal
    LOOP
      v_sort_key := pg_catalog.int8send((
        SELECT pg_catalog.count(*)
        FROM pg_catalog.jsonb_array_elements(v_source_body->'fields')
          AS field(value)
        WHERE field.value->'stable_key_ordinal' <> 'null'::jsonb
      ));
      FOR v_stable_field IN
        SELECT field.value,
          pg_catalog.substr(
            field.value->>'stable_key_ordinal', 5
          )::integer AS stable_ordinal
        FROM pg_catalog.jsonb_array_elements(v_source_body->'fields')
          AS field(value)
        WHERE field.value->'stable_key_ordinal' <> 'null'::jsonb
        ORDER BY stable_ordinal
      LOOP
        SELECT input_value.value INTO STRICT v_stable_value
        FROM pg_catalog.jsonb_array_elements(
          v_input_row.value->'values'
        ) AS input_value(value)
        WHERE input_value.value->>'field_id' =
          v_stable_field.value->>'field_id';
        v_sort_key := v_sort_key
          || pg_catalog.uuid_send((v_stable_field.value->>'field_id')::uuid)
          || CASE v_stable_value->>'type'
            WHEN 'boolean' THEN pg_catalog.decode('00', 'hex')
            WHEN 'integer' THEN pg_catalog.decode('01', 'hex')
            WHEN 'decimal' THEN pg_catalog.decode('02', 'hex')
            WHEN 'text' THEN pg_catalog.decode('03', 'hex')
            WHEN 'date' THEN pg_catalog.decode('04', 'hex')
            ELSE pg_catalog.decode('05', 'hex') END
          || CASE v_stable_value->>'state'
            WHEN 'present' THEN pg_catalog.decode('00', 'hex')
            WHEN 'null' THEN pg_catalog.decode('01', 'hex')
            WHEN 'missing' THEN pg_catalog.decode('02', 'hex')
            ELSE pg_catalog.decode('03', 'hex') END;
        IF v_stable_value->>'state' = 'present' THEN
          CASE v_stable_value->>'type'
            WHEN 'boolean' THEN
              v_sort_key := v_sort_key || CASE
                WHEN (v_stable_value->>'value')::boolean
                  THEN pg_catalog.decode('01', 'hex')
                ELSE pg_catalog.decode('00', 'hex') END;
            WHEN 'integer' THEN
              v_sort_key := v_sort_key || pg_catalog.int8send(
                pg_catalog.substr(v_stable_value->>'value', 5)::bigint
              );
            WHEN 'decimal' THEN
              v_decimal_unsigned := (
                v_stable_value#>>'{value,coefficient}'
              )::numeric;
              IF v_decimal_unsigned < 0 THEN
                v_decimal_unsigned := v_decimal_unsigned
                  + pg_catalog.power(2::numeric, 128);
              END IF;
              FOR v_decimal_index IN 0..15 LOOP
                v_decimal_byte := pg_catalog.mod(pg_catalog.floor(
                  v_decimal_unsigned / pg_catalog.power(
                    256::numeric, 15 - v_decimal_index
                  )
                ), 256)::integer;
                v_sort_key := pg_catalog.set_byte(
                  v_sort_key || pg_catalog.decode('00', 'hex'),
                  pg_catalog.octet_length(v_sort_key), v_decimal_byte
                );
              END LOOP;
              v_sort_key := v_sort_key || pg_catalog.set_byte(
                pg_catalog.decode('00', 'hex'), 0,
                pg_catalog.substr(
                  v_stable_value#>>'{value,scale}', 5
                )::integer
              );
            WHEN 'text' THEN
              v_sort_key := v_sort_key || pg_catalog.int4send(
                pg_catalog.octet_length(pg_catalog.convert_to(
                  v_stable_value->>'value', 'UTF8'
                ))
              ) || pg_catalog.convert_to(v_stable_value->>'value', 'UTF8');
            WHEN 'date' THEN
              v_sort_key := v_sort_key || pg_catalog.int4send(
                (v_stable_value->>'value')::date - DATE '1970-01-01'
              );
            ELSE
              v_sort_key := v_sort_key || pg_catalog.int8send((
                extract(epoch FROM
                  (v_stable_value->>'value')::timestamptz
                ) * 1000000
              )::bigint);
          END CASE;
        END IF;
      END LOOP;
      v_expected_row_id := dasher_private.uuid_v8_from_sha256_v1(
        pg_catalog.convert_to('dasher.input-row-id.v1', 'UTF8')
        || pg_catalog.decode('00', 'hex')
        || pg_catalog.uuid_send(v_source.snapshot_id)
        || v_sort_key
      );
      IF (v_input_row.value->>'row_id')::uuid <> v_expected_row_id
        OR (v_prior_sort_key IS NOT NULL AND ROW(
          v_prior_sort_key, pg_catalog.uuid_send(v_prior_row_id)
        ) >= ROW(
          v_sort_key,
          pg_catalog.uuid_send((v_input_row.value->>'row_id')::uuid)
        ))
      THEN
        RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
      END IF;
      v_prior_sort_key := v_sort_key;
      v_prior_row_id := (v_input_row.value->>'row_id')::uuid;
    END LOOP;
  EXCEPTION
    WHEN SQLSTATE '22021' OR SQLSTATE '22P02' THEN
      RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END;
  SELECT catalog.* INTO v_catalog
  FROM dasher.field_catalog_snapshots AS catalog
  WHERE catalog.organization_id = v_organization_id
    AND catalog.dashboard_id = p_dashboard_id
    AND catalog.input_snapshot_id = p_input_snapshot_id
    AND catalog.input_sha256 = p_expected_input_sha256
  ORDER BY catalog.evaluated_at DESC, catalog.catalog_snapshot_id
  LIMIT 1
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  v_field_catalog := pg_catalog.convert_from(
    v_catalog.canonical_bytes, 'UTF8'
  )::jsonb;
  SELECT pg_catalog.jsonb_build_object(
      'schema', 'field-catalog-snapshot-v1',
      'catalog_snapshot_id', v_catalog.catalog_snapshot_id::text,
      'input_snapshot_id', v_catalog.input_snapshot_id::text,
      'input_sha256', pg_catalog.encode(v_catalog.input_sha256, 'hex'),
      'input_row_count', 'i64:' || v_catalog.input_row_count::text,
      'evaluated_at', pg_catalog.to_char(
        v_catalog.evaluated_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ),
      'fields', pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'field_id', entry.field_id::text,
        'source_path', entry.source_path,
        'logical_name', entry.logical_name,
        'scalar_type', entry.scalar_type,
        'nullable', entry.nullable,
        'semantic_type', entry.semantic_type,
        'unit', entry.unit,
        'currency', entry.currency,
        'grain', entry.grain,
        'event_time_field_id', entry.event_time_field_id::text,
        'stable_key_ordinal', CASE WHEN entry.stable_key_ordinal IS NULL
          THEN NULL ELSE 'i64:' || entry.stable_key_ordinal::text END,
        'max_value_bytes', 'i64:' || entry.max_value_bytes::text,
        'allowed_aggregations', entry.allowed_aggregations,
        'allowed_dimensions', entry.allowed_dimensions,
        'lineage_evidence_ids', entry.lineage_evidence_ids
      ) ORDER BY pg_catalog.uuid_send(entry.field_id))
    ) INTO v_rebuilt_field_catalog
  FROM dasher.field_catalog_entries AS entry
  WHERE entry.organization_id = v_catalog.organization_id
    AND entry.dashboard_id = v_catalog.dashboard_id
    AND entry.catalog_snapshot_id = v_catalog.catalog_snapshot_id;
  IF v_rebuilt_field_catalog IS NULL
    OR v_rebuilt_field_catalog IS DISTINCT FROM v_field_catalog
    OR dasher_private.canonical_jsonb_bytes_v1(v_field_catalog)
      IS DISTINCT FROM v_catalog.canonical_bytes
    OR v_catalog.catalog_sha256 IS DISTINCT FROM pg_catalog.sha256(
      pg_catalog.convert_to('dasher.field-catalog-snapshot.v1', 'UTF8')
      || pg_catalog.decode('00', 'hex')
      || pg_catalog.int4send(pg_catalog.octet_length(v_catalog.canonical_bytes))
      || v_catalog.canonical_bytes
    )
    OR v_catalog.input_row_count <> pg_catalog.jsonb_array_length(
      v_source_body->'rows'
    )
    OR (SELECT pg_catalog.count(*)
        FROM dasher.field_catalog_entries AS entry
        WHERE entry.organization_id = v_catalog.organization_id
          AND entry.dashboard_id = v_catalog.dashboard_id
          AND entry.catalog_snapshot_id = v_catalog.catalog_snapshot_id) <>
      pg_catalog.jsonb_array_length(v_source_body->'fields')
    OR EXISTS (
      SELECT 1
      FROM dasher.field_catalog_entries AS entry
      JOIN LATERAL pg_catalog.jsonb_array_elements(
        v_field_catalog->'fields'
      ) AS field(value) ON field.value->>'field_id' = entry.field_id::text
      WHERE entry.organization_id = v_catalog.organization_id
        AND entry.dashboard_id = v_catalog.dashboard_id
        AND entry.catalog_snapshot_id = v_catalog.catalog_snapshot_id
        AND entry.entry_sha256 IS DISTINCT FROM pg_catalog.sha256(
          pg_catalog.convert_to('dasher.field-catalog-entry.v1', 'UTF8')
          || pg_catalog.decode('00', 'hex')
          || pg_catalog.int4send(pg_catalog.octet_length(
            dasher_private.canonical_jsonb_bytes_v1(field.value)
          )) || dasher_private.canonical_jsonb_bytes_v1(field.value)
        )
    )
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.jsonb_array_elements(v_source_body->'fields')
        AS input_field(value)
      WHERE NOT EXISTS (
        SELECT 1
        FROM dasher.field_catalog_entries AS entry
        WHERE entry.organization_id = v_catalog.organization_id
          AND entry.dashboard_id = v_catalog.dashboard_id
          AND entry.catalog_snapshot_id = v_catalog.catalog_snapshot_id
          AND entry.field_id = (input_field.value->>'field_id')::uuid
          AND entry.scalar_type = input_field.value->>'scalar_type'
          AND entry.nullable = (input_field.value->>'nullable')::boolean
          AND entry.stable_key_ordinal IS NOT DISTINCT FROM CASE
            WHEN input_field.value->'stable_key_ordinal' = 'null'::jsonb
              THEN NULL
            ELSE pg_catalog.substr(
              input_field.value->>'stable_key_ordinal', 5
            )::integer END
      )
    )
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  SELECT pg_catalog.jsonb_build_object(
      'schema', 'metric-contract-set-v1',
      'contract_set_id', contract.contract_set_id::text,
      'catalog_snapshot_id', contract.catalog_snapshot_id::text,
      'contracts', pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'contract_id', contract.contract_id::text,
        'version', 'i64:' || contract.contract_version::text,
        'business_owner_membership_id',
          contract.business_owner_membership_id::text,
        'data_owner_membership_id', contract.data_owner_membership_id::text,
        'name', contract.name,
        'definition', contract.definition,
        'measure_field_id', contract.measure_field_id::text,
        'aggregation', contract.aggregation,
        'denominator_contract_id', contract.denominator_contract_id::text,
        'denominator_contract_version', CASE
          WHEN contract.denominator_contract_version IS NULL THEN NULL
          ELSE 'i64:' || contract.denominator_contract_version::text END,
        'value_type', contract.value_type,
        'unit', contract.unit,
        'currency', contract.currency,
        'direction', contract.direction,
        'threshold', contract.threshold,
        'target', contract.target,
        'grain', contract.grain,
        'lag_millis', 'i64:' || contract.lag_millis::text,
        'freshness_slo_millis',
          'i64:' || contract.freshness_slo_millis::text,
        'allowed_dimension_field_ids', contract.allowed_dimension_field_ids,
        'calendar', contract.calendar,
        'timezone', contract.timezone,
        'lineage_evidence_ids', contract.lineage_evidence_ids,
        'review_state', contract.review_state
      ) ORDER BY contract.contract_id, contract.contract_version)
    ) INTO v_metric_contract_set
  FROM dasher.metric_contract_versions AS contract
  WHERE contract.organization_id = v_organization_id
    AND contract.dashboard_id = p_dashboard_id
    AND contract.catalog_snapshot_id = v_catalog.catalog_snapshot_id
    AND contract.review_state = 'reviewed'
  GROUP BY contract.contract_set_id, contract.catalog_snapshot_id;
  IF v_metric_contract_set IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  PERFORM 1
  FROM dasher.metric_contract_versions AS contract
  WHERE contract.organization_id = v_organization_id
    AND contract.dashboard_id = p_dashboard_id
    AND contract.catalog_snapshot_id = v_catalog.catalog_snapshot_id
    AND contract.contract_set_id =
      (v_metric_contract_set->>'contract_set_id')::uuid
  ORDER BY pg_catalog.uuid_send(contract.contract_id),
    contract.contract_version
  FOR KEY SHARE;
  IF NOT FOUND
    OR (SELECT pg_catalog.count(DISTINCT contract.contract_set_id)
        FROM dasher.metric_contract_versions AS contract
        WHERE contract.organization_id = v_organization_id
          AND contract.dashboard_id = p_dashboard_id
          AND contract.catalog_snapshot_id = v_catalog.catalog_snapshot_id
          AND contract.review_state = 'reviewed') <> 1
    OR EXISTS (
      SELECT 1
      FROM dasher.metric_contract_versions AS contract
      WHERE contract.organization_id = v_organization_id
        AND contract.dashboard_id = p_dashboard_id
        AND contract.catalog_snapshot_id = v_catalog.catalog_snapshot_id
        AND (
          contract.contract_set_id <>
            (v_metric_contract_set->>'contract_set_id')::uuid
          OR contract.contract_set_sha256 IS DISTINCT FROM pg_catalog.sha256(
            pg_catalog.convert_to('dasher.metric-contract-set.v1', 'UTF8')
            || pg_catalog.decode('00', 'hex')
            || pg_catalog.int4send(pg_catalog.octet_length(
              dasher_private.canonical_jsonb_bytes_v1(v_metric_contract_set)
            ))
            || dasher_private.canonical_jsonb_bytes_v1(v_metric_contract_set)
          )
          OR contract.contract_sha256 IS DISTINCT FROM (
            SELECT pg_catalog.sha256(
              pg_catalog.convert_to(
                'dasher.metric-contract-version.v1', 'UTF8'
              ) || pg_catalog.decode('00', 'hex')
              || pg_catalog.int4send(pg_catalog.octet_length(
                dasher_private.canonical_jsonb_bytes_v1(member.value)
              )) || dasher_private.canonical_jsonb_bytes_v1(member.value)
            )
            FROM pg_catalog.jsonb_array_elements(
              v_metric_contract_set->'contracts'
            ) AS member(value)
            WHERE member.value->>'contract_id' = contract.contract_id::text
              AND member.value->>'version' =
                'i64:' || contract.contract_version::text
          )
          OR NOT EXISTS (
            SELECT 1 FROM dasher.memberships AS owner_membership
            WHERE owner_membership.organization_id = contract.organization_id
              AND owner_membership.membership_id =
                contract.business_owner_membership_id
              AND owner_membership.state = 'active'
              AND owner_membership.revoked_at IS NULL
          )
          OR NOT EXISTS (
            SELECT 1 FROM dasher.memberships AS owner_membership
            WHERE owner_membership.organization_id = contract.organization_id
              AND owner_membership.membership_id =
                contract.data_owner_membership_id
              AND owner_membership.state = 'active'
              AND owner_membership.revoked_at IS NULL
          )
          OR NOT EXISTS (
            SELECT 1 FROM dasher.field_catalog_entries AS measure
            WHERE measure.organization_id = contract.organization_id
              AND measure.dashboard_id = contract.dashboard_id
              AND measure.catalog_snapshot_id = contract.catalog_snapshot_id
              AND measure.field_id = contract.measure_field_id
          )
          OR EXISTS (
            SELECT 1
            FROM pg_catalog.unnest(contract.allowed_dimension_field_ids)
              AS dimension(field_id)
            WHERE NOT EXISTS (
              SELECT 1 FROM dasher.field_catalog_entries AS field
              WHERE field.organization_id = contract.organization_id
                AND field.dashboard_id = contract.dashboard_id
                AND field.catalog_snapshot_id = contract.catalog_snapshot_id
                AND field.field_id = dimension.field_id
            )
          )
          OR EXISTS (
            SELECT 1
            FROM pg_catalog.unnest(contract.lineage_evidence_ids)
              AS lineage(evidence_id)
            WHERE NOT EXISTS (
              SELECT 1 FROM dasher.evidence_records AS evidence
              WHERE evidence.organization_id = contract.organization_id
                AND evidence.evidence_id = lineage.evidence_id
                AND evidence.snapshot_id = p_input_snapshot_id
            )
          )
          OR (contract.denominator_contract_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM dasher.metric_contract_versions AS denominator
            WHERE denominator.organization_id = contract.organization_id
              AND denominator.dashboard_id = contract.dashboard_id
              AND denominator.contract_set_id = contract.contract_set_id
              AND denominator.contract_id = contract.denominator_contract_id
              AND denominator.contract_version =
                contract.denominator_contract_version
          ))
        )
    )
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  v_request_json := pg_catalog.jsonb_build_object(
    'schema', 'agent-run-request-v1',
    'run_request_id', p_run_request_id::text,
    'request_idempotency_sha256', pg_catalog.encode(p_idempotency_sha256, 'hex'),
    'dashboard_id', p_dashboard_id::text,
    'input_snapshot_id', p_input_snapshot_id::text,
    'input_sha256', pg_catalog.encode(p_expected_input_sha256, 'hex'),
    'input_table', pg_catalog.convert_from(v_source.canonical_bytes, 'UTF8')::jsonb,
    'purpose', p_purpose,
    'evaluation_time', pg_catalog.to_char(
      v_now AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ),
    'policy_revision', 'i64:' || v_policy.policy_revision::text,
    'field_catalog', v_field_catalog,
    'metric_contract_set', v_metric_contract_set,
    'generation_limit_vector', pg_catalog.jsonb_build_object(
      'calls','i64:4','candidates','i64:2','specialist_attempts','i64:1',
      'reviewer_attempts','i64:0','repair_attempts','i64:1',
      'input_tokens','i64:20000','output_tokens','i64:8000',
      'reasoning_tokens','i64:8000','cache_read_tokens','i64:20000',
      'cache_write_tokens','i64:8000','total_tokens','i64:24000',
      'wall_millis','i64:36000','work_millis','i64:32000',
      'cost_micros','i64:120000'
    ),
    'review_limit_vector', pg_catalog.jsonb_build_object(
      'calls','i64:1','candidates','i64:0','specialist_attempts','i64:0',
      'reviewer_attempts','i64:1','repair_attempts','i64:0',
      'input_tokens','i64:5000','output_tokens','i64:2000',
      'reasoning_tokens','i64:2000','cache_read_tokens','i64:5000',
      'cache_write_tokens','i64:2000','total_tokens','i64:6000',
      'wall_millis','i64:9000','work_millis','i64:8000',
      'cost_micros','i64:30000'
    ),
    'orchestration_limits', pg_catalog.jsonb_build_object(
      'active_organization_runs','i64:2','active_dashboard_runs','i64:1',
      'approval_required_dashboard_runs','i64:2','provider_concurrency','i64:1',
      'tool_attempts','i64:0','transient_retries','i64:1'
    ),
    'adapter_id', v_policy.adapter_id,
    'model_id', v_policy.model_id,
    'price_book_revision', v_policy.price_book_revision,
    'replay_source_run_id', p_replay_source_run_id::text,
    'replay_source_result_count', CASE WHEN p_purpose = 'replay'
      THEN 'i64:' || v_replay_result_count::text ELSE NULL END,
    'replay_source_head_sha256', pg_catalog.encode(v_replay_head_sha, 'hex'),
    'replay_source_candidate_set_sha256', pg_catalog.encode(
      v_replay_source.candidate_set_sha256, 'hex'
    ),
    'replay_source_bundle_id', v_replay_bundle.bundle_id::text,
    'replay_source_bundle_sha256', pg_catalog.encode(
      v_replay_bundle.bundle_sha256, 'hex'
    ),
    'replay_source_brief_id', v_replay_brief.brief_id::text,
    'replay_source_brief_sha256', pg_catalog.encode(
      v_replay_brief.brief_sha256, 'hex'
    ),
    'replay_source_selected_candidate_id',
      v_replay_source.selected_candidate_id::text
  );
  IF (SELECT pg_catalog.count(*)
      FROM pg_catalog.jsonb_object_keys(v_request_json)) <> 27
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  v_request_bytes := dasher_private.canonical_jsonb_bytes_v1(v_request_json);
  IF pg_catalog.octet_length(v_request_bytes) NOT BETWEEN 1 AND 1638400 THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  v_request_semantic_sha := pg_catalog.sha256(
    pg_catalog.convert_to('dasher.agent-run-request.v1', 'UTF8')
    || pg_catalog.decode('00', 'hex')
    || pg_catalog.int4send(pg_catalog.octet_length(v_request_bytes))
    || v_request_bytes
  );
  v_request_sha := pg_catalog.sha256(
    pg_catalog.convert_to('dasher.retained-payload-envelope.v1', 'UTF8')
    || pg_catalog.decode('00', 'hex')
    || pg_catalog.int4send(pg_catalog.octet_length('agent-run-request-v1'))
    || pg_catalog.convert_to('agent-run-request-v1', 'UTF8')
    || pg_catalog.int4send(pg_catalog.octet_length(v_nonce))
    || v_nonce
    || pg_catalog.int4send(pg_catalog.octet_length(v_request_semantic_sha))
    || v_request_semantic_sha
  );
  IF v_existing_found THEN
    SELECT payload.* INTO v_existing_payload
    FROM dasher.agent_run_request_payloads AS payload
    WHERE payload.organization_id = v_existing.organization_id
      AND payload.dashboard_id = v_existing.dashboard_id
      AND payload.request_payload_id = v_existing.request_payload_id;
    IF NOT FOUND
      OR v_existing.requesting_user_id <> v_user_id
      OR v_existing.requesting_membership_id <> v_membership_id
      OR v_existing.requesting_authority_revision <> v_authority_revision
      OR v_existing.policy_revision <> v_policy.policy_revision
      OR v_existing.dashboard_id <> p_dashboard_id
      OR v_existing_payload.run_request_id <> p_run_request_id
      OR v_existing_payload.request_idempotency_sha256 <> p_idempotency_sha256
      OR v_existing_payload.canonical_bytes IS DISTINCT FROM v_request_bytes
      OR v_existing_payload.request_sha256 IS DISTINCT FROM pg_catalog.sha256(
        pg_catalog.convert_to('dasher.retained-payload-envelope.v1', 'UTF8')
        || pg_catalog.decode('00', 'hex')
        || pg_catalog.int4send(pg_catalog.octet_length('agent-run-request-v1'))
        || pg_catalog.convert_to('agent-run-request-v1', 'UTF8')
        || pg_catalog.int4send(pg_catalog.octet_length(
          v_existing_payload.content_nonce
        ))
        || v_existing_payload.content_nonce
        || pg_catalog.int4send(pg_catalog.octet_length(
          v_request_semantic_sha
        ))
        || v_request_semantic_sha
      )
      OR 1 <> (
        SELECT pg_catalog.count(*)
        FROM dasher.audit_events AS audit
        WHERE audit.organization_id = v_existing.organization_id
          AND audit.actor_kind = 'user'
          AND audit.actor_user_id = v_user_id
          AND audit.actor_service IS NULL
          AND audit.authority_revision = v_authority_revision
          AND audit.request_id IS NOT NULL
          AND audit.job_id IS NULL
          AND audit.action = 'dashboard.agent_run_requested'
          AND audit.target_type = 'agent_run'
          AND audit.target_id = v_existing.run_id
          AND audit.outcome = 'succeeded'
          AND audit.content_sha256 = v_existing_payload.request_sha256
          AND audit.source_ref IS NULL
          AND audit.provider IS NULL
          AND audit.credential_version IS NULL
          AND audit.usage_units IS NULL
          AND audit.cost_minor_units IS NULL
          AND audit.deployment_revision = p_deployment_revision
      )
    THEN
      RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
    END IF;
    RETURN ROW(
      v_existing.run_id, 1::bigint, 'requested'::text,
      v_existing.policy_revision, v_existing_payload.request_sha256
    )::dasher_api.agent_run_request_result;
  END IF;
  v_event_body := pg_catalog.jsonb_build_object(
    'run_request_id', p_run_request_id::text,
    'request_payload_id', v_request_payload_id::text,
    'request_idempotency_sha256', pg_catalog.encode(p_idempotency_sha256, 'hex'),
    'request_sha256', pg_catalog.encode(v_request_sha, 'hex'),
    'policy_revision', 'i64:' || v_policy.policy_revision::text,
    'purpose', p_purpose,
    'replay_source_run_id', p_replay_source_run_id::text
  );
  v_compact_event_body := pg_catalog.convert_from(
    dasher_private.canonical_jsonb_bytes_v1(v_event_body), 'UTF8'
  );
  v_event_payload_bytes := pg_catalog.convert_to(
    '{"actor_id":' || pg_catalog.to_jsonb(v_user_id::text)::text
    || ',"actor_kind":"tenant"'
    || ',"actor_revision":' || pg_catalog.to_jsonb(
      'i64:' || v_authority_revision::text
    )::text
    || ',"body":' || v_compact_event_body
    || ',"event_id":' || pg_catalog.to_jsonb(v_event_id::text)::text
    || ',"event_kind":"run_requested"'
    || ',"event_sequence":"i64:1"'
    || ',"occurred_at":' || pg_catalog.to_jsonb(pg_catalog.to_char(
      v_now AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ))::text
    || ',"run_id":' || pg_catalog.to_jsonb(v_run_id::text)::text
    || ',"run_revision":"i64:1"'
    || ',"schema":"agent-run-event-payload-v1"}',
    'UTF8'
  );
  v_event_semantic_sha := pg_catalog.sha256(
    pg_catalog.convert_to('dasher.agent-run-event-payload.v1', 'UTF8')
    || pg_catalog.decode('00', 'hex')
    || pg_catalog.int4send(pg_catalog.octet_length(v_event_payload_bytes))
    || v_event_payload_bytes
  );
  v_event_payload_sha := pg_catalog.sha256(
    pg_catalog.convert_to('dasher.retained-payload-envelope.v1', 'UTF8')
    || pg_catalog.decode('00', 'hex')
    || pg_catalog.int4send(
      pg_catalog.octet_length('agent-run-event-payload-v1')
    )
    || pg_catalog.convert_to('agent-run-event-payload-v1', 'UTF8')
    || pg_catalog.int4send(pg_catalog.octet_length(v_nonce))
    || v_nonce
    || pg_catalog.int4send(pg_catalog.octet_length(v_event_semantic_sha))
    || v_event_semantic_sha
  );
  v_event_sha := pg_catalog.sha256(
    pg_catalog.convert_to('dasher.agent-run-event.v1', 'UTF8')
    || pg_catalog.decode('00', 'hex')
    || pg_catalog.uuid_send(v_run_id)
    || pg_catalog.int8send(1)
    || pg_catalog.int4send(pg_catalog.octet_length('run_requested'))
    || pg_catalog.convert_to('run_requested', 'UTF8')
    || pg_catalog.int8send((
      extract(epoch FROM v_now) * 1000000
    )::bigint)
    || pg_catalog.decode('00', 'hex')
    || pg_catalog.decode('00', 'hex')
    || v_event_payload_sha
  );

  INSERT INTO dasher.agent_run_request_payloads (
    organization_id, dashboard_id, request_payload_id, run_request_id,
    request_idempotency_sha256, content_nonce, canonical_bytes,
    request_sha256, created_at
  ) VALUES (
    v_organization_id, p_dashboard_id, v_request_payload_id, p_run_request_id,
    p_idempotency_sha256, v_nonce, v_request_bytes, v_request_sha, v_now
  );
  INSERT INTO dasher.agent_runs (
    organization_id, dashboard_id, run_id, run_request_id, request_payload_id,
    requesting_user_id, requesting_membership_id,
    requesting_authority_revision, policy_revision, requested_at, state,
    run_revision, current_event_sequence, current_event_sha256, lease_epoch,
    lease_token_sha256, lease_owner_principal_id,
    lease_owner_principal_revision, lease_expires_at,
    latest_checkpoint_revision, candidate_set_sha256,
    candidate_set_closed_at, terminal_at, terminal_reason_sha256,
    selected_candidate_id, consumed_replay_sequence, consumed_replay_sha256,
    terminal_operation_kind, terminal_operation_id,
    terminal_claim_input_sha256, terminal_operation_sha256,
    tenant_cancel_operation_id, tenant_cancel_operation_sha256,
    tenant_cancel_result_sha256, tenant_cancel_result_run_revision,
    tenant_cancel_result_event_sequence, tenant_cancel_result_event_sha256
  ) VALUES (
    v_organization_id, p_dashboard_id, v_run_id, p_run_request_id,
    v_request_payload_id, v_user_id, v_membership_id, v_authority_revision,
    v_policy.policy_revision, v_now, 'requested', 1, 1, v_event_sha, 0,
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
  );

  INSERT INTO dasher.agent_run_budget_counters (
    organization_id, dashboard_id, run_id, partition, vector_field,
    limit_units, reserved_units, used_units, released_units, updated_at
  )
  SELECT v_organization_id, p_dashboard_id, v_run_id, limits.partition,
    fields.vector_field, fields.limit_units, 0, 0, 0, v_now
  FROM (VALUES
    ('generation'::text, ARRAY[4,2,1,0,1,20000,8000,8000,20000,8000,24000,36000,32000,120000]::bigint[]),
    ('review'::text, ARRAY[1,0,0,1,0,5000,2000,2000,5000,2000,6000,9000,8000,30000]::bigint[])
  ) AS limits(partition, units)
  CROSS JOIN LATERAL unnest(
    ARRAY['calls','candidates','specialist_attempts','reviewer_attempts',
      'repair_attempts','input_tokens','output_tokens','reasoning_tokens',
      'cache_read_tokens','cache_write_tokens','total_tokens','wall_millis',
      'work_millis','cost_micros']::text[],
    limits.units
  ) AS fields(vector_field, limit_units);

  INSERT INTO dasher.agent_run_event_payloads (
    organization_id, dashboard_id, run_id, event_payload_id, event_id,
    event_sequence, content_nonce, canonical_bytes, payload_sha256, created_at
  ) VALUES (
    v_organization_id, p_dashboard_id, v_run_id, v_event_payload_id,
    v_event_id, 1, v_nonce, v_event_payload_bytes, v_event_payload_sha, v_now
  );
  INSERT INTO dasher.agent_run_events (
    organization_id, dashboard_id, run_id, event_sequence, event_id,
    event_kind, occurred_at, prior_event_sequence, prior_event_sha256,
    event_payload_id, event_sha256, claim_operation_kind, claim_request_id,
    claim_input_sha256, claim_result_sha256, claim_result_run_revision,
    claim_result_state, claim_result_lease_epoch, claim_result_attempt_token,
    claim_result_lease_expires_at, claim_result_policy_revision,
    claim_result_input_sha256
  ) VALUES (
    v_organization_id, p_dashboard_id, v_run_id, 1, v_event_id,
    'run_requested', v_now, NULL, NULL, v_event_payload_id, v_event_sha,
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
  );
  BEGIN
    INSERT INTO dasher.audit_events (
      audit_event_id, organization_id, occurred_at, actor_kind, actor_user_id,
      actor_service, authority_revision, request_id, job_id, action,
      target_type, target_id, outcome, content_sha256, source_ref, provider,
      credential_version, usage_units, cost_minor_units, deployment_revision
    ) VALUES (
      p_audit_event_id, v_organization_id, v_now, 'user', v_user_id, NULL,
      v_authority_revision, v_request_id, NULL, 'dashboard.agent_run_requested',
      'agent_run', v_run_id, 'succeeded', v_request_sha, NULL, NULL, NULL,
      NULL, NULL, p_deployment_revision
    );
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END;

  v_result := ROW(
    v_run_id, 1::bigint, 'requested'::text,
    v_policy.policy_revision, v_request_sha
  )::dasher_api.agent_run_request_result;
  RETURN v_result;
END
$function$;

-- Part 8 - dasher_retention_api.purge_dashboard audit-event-id collision
-- normalization.
--
-- The last of the four frozen 0007 sites that write the global
-- dasher.audit_events primary key from a caller-supplied uuid without any
-- probe that could observe the id being spent in another scope. Here the
-- parameter is operation_and_audit_id, and every guard the function carries -
-- the tombstone lookup, the lifecycle-revision fence, the cleanup-completion
-- proof, the finalizer and reference-claim sweeps - is scoped to this
-- organization and this dashboard. A uuid already spent by an audit row
-- belonging to a different dashboard, target type or organization passes all
-- of them, the purge runs to completion, and the audit INSERT at the end
-- raises a bare 23505 carrying the constraint name instead of the P1002 /
-- dasher_conflict this series requires.
--
-- The re-issued body below is byte-identical to the frozen 0007 definition
-- apart from the audit INSERT, which is wrapped in the same block Part 6 uses
-- on the age-out. Signature, SECURITY DEFINER, search path, volatility, the
-- `#variable_conflict use_variable` directive, every declaration, every
-- positional parameter reference, every ON CONFLICT inference list, every
-- FOR UPDATE row mark, every proof recomputation and every other RAISE are
-- preserved. Frozen 0007 already re-issued this function over its 0006
-- ancestor, so the header is CREATE OR REPLACE FUNCTION in the frozen bytes
-- too and is carried through unchanged.
--
-- Only the single INSERT statement is inside the block; the immediately
-- preceding dasher.dashboard_lifecycle_events INSERT, which writes the same
-- uuid into a different table's primary key, is deliberately left outside it.
-- That key is scoped by (organization_id, dashboard_id) rather than global, so
-- it cannot be spent from another scope, and wrapping it would widen this
-- correction past the one defect it is for. The handler re-raises rather than
-- swallowing, so the block's subtransaction unwinds the audit INSERT and the
-- propagating exception unwinds the entire purge - the deletes, the finalizer
-- rows, the tombstone update, the lifecycle event - leaving the dashboard
-- exactly as it was before the call.

CREATE OR REPLACE FUNCTION dasher_retention_api.purge_dashboard(
  dashboard_id uuid,
  expected_lifecycle_revision bigint,
  cleanup_completion_proof_sha256 bytea,
  operation_and_audit_id uuid,
  deployment_revision text,
  target_organization_id uuid
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
#variable_conflict use_variable
DECLARE
  v_organization_id uuid;
  v_authority_revision bigint;
  v_dashboard dasher.dashboards%ROWTYPE;
  v_coordination dasher.dashboard_cleanup_coordination%ROWTYPE;
  v_now timestamptz;
  v_ledger_sequence bigint;
  v_row_count integer;
  v_expected_delete_count integer;
  v_deleted_row_count integer;
  v_snapshot_ids uuid[];
  v_evidence_ids uuid[];
  v_artifact_ids uuid[];
  v_gap_snapshot_id uuid;
  v_gap_evidence_id uuid;
  v_gap_artifact_id uuid;
  v_batch_limit constant integer := 100;
  v_expected bytea;
  v_phase7_expected_counts jsonb;
  v_phase7_deleted_count bigint;
  v_bundle_membership_sha256 bytea;
  v_bundle_membership_recheck_sha256 bytea;
BEGIN
  IF current_user <> 'dasher_retention_definer'::name
    OR $1 IS NULL OR $2 < 0
    OR $6 IS NULL
    OR ($3 IS NOT NULL AND octet_length($3) <> 32)
    OR $4 IS NULL OR $5 IS NULL OR btrim($5) <> $5
    OR char_length($5) NOT BETWEEN 1 AND 64 OR $5 ~ '[[:cntrl:]]'
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  PERFORM dasher_retention_api.initialize_operator_context(
    $1, 'purge', $4, $5, $6
  );
  SELECT coordination.* INTO STRICT v_coordination
  FROM dasher.dashboard_cleanup_coordination AS coordination
  WHERE coordination.organization_id = current_setting(
      'dasher.retention_target_organization_id', true
    )::uuid
    AND coordination.dashboard_id = $1
  FOR UPDATE OF coordination;
  v_organization_id := current_setting(
    'dasher.retention_target_organization_id', true
  )::uuid;
  v_authority_revision := current_setting(
    'dasher.retention_principal_revision', true
  )::bigint;
  PERFORM 1 FROM dasher.retention_service_principal_allowlist AS authority
  WHERE authority.retention_service_principal_id = current_setting(
      'dasher.retention_principal_id', true
    )::uuid
    AND authority.principal_revision = current_setting(
      'dasher.retention_principal_revision', true
    )::bigint
    AND authority.binding_kind = 'postgres_session_user'
    AND authority.binding_subject = session_user AND authority.enabled
    AND authority.authority_scope = 'platform_operator'
    AND authority.scope_organization_id IS NULL AND authority.can_purge
    AND NOT EXISTS (
      SELECT 1 FROM dasher.retention_service_principal_allowlist AS later
      WHERE later.retention_service_principal_id = authority.retention_service_principal_id
        AND later.principal_revision > authority.principal_revision
    );
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  PERFORM 1 FROM dasher.dashboard_lifecycle_policies AS policy
  WHERE policy.organization_id = v_organization_id
  ORDER BY policy.policy_revision DESC LIMIT 1 FOR UPDATE OF policy;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  SELECT * INTO v_dashboard FROM dasher.dashboards AS dashboard
  WHERE dashboard.organization_id = v_organization_id
    AND dashboard.dashboard_id = $1
    AND dashboard.lifecycle_revision = $2
    AND dashboard.lifecycle_state = 'purge_eligible'
    AND dashboard.purge_after IS NOT NULL
    AND dashboard.purged_at IS NULL
  FOR UPDATE OF dashboard;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  PERFORM 1 FROM dasher.dashboard_legal_holds AS hold
  WHERE hold.organization_id = v_organization_id AND hold.dashboard_id = $1
    AND hold.released_at IS NULL
  ORDER BY hold.hold_id FOR UPDATE OF hold;
  IF FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  v_now := clock_timestamp();
  IF v_now < v_dashboard.purge_after THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  PERFORM set_config(
    'dasher.retention_expected_lifecycle_revision', $2::text, true
  );
  -- Exact phase-7 lock extension: stable relation order and key order.
  PERFORM 1 FROM dasher.agent_runs AS run
  WHERE run.organization_id = v_organization_id AND run.dashboard_id = $1
  ORDER BY pg_catalog.uuid_send(run.run_id) FOR UPDATE OF run;
  PERFORM 1 FROM dasher.dashboard_versions AS version
  WHERE version.organization_id = v_organization_id AND version.dashboard_id = $1
  ORDER BY pg_catalog.uuid_send(version.version_id) FOR UPDATE OF version;
  PERFORM 1 FROM dasher.source_snapshots AS snapshot
  WHERE snapshot.organization_id = v_organization_id AND EXISTS (
    SELECT 1 FROM dasher.dashboard_version_snapshots AS link
    WHERE link.organization_id = snapshot.organization_id
      AND link.dashboard_id = $1 AND link.snapshot_id = snapshot.snapshot_id
  ) ORDER BY pg_catalog.uuid_send(snapshot.snapshot_id) FOR UPDATE OF snapshot;
  PERFORM 1 FROM dasher.evidence_records AS evidence
  WHERE evidence.organization_id = v_organization_id AND EXISTS (
    SELECT 1 FROM dasher.dashboard_version_evidence AS link
    WHERE link.organization_id = evidence.organization_id
      AND link.dashboard_id = $1 AND link.evidence_id = evidence.evidence_id
  ) ORDER BY pg_catalog.uuid_send(evidence.evidence_id) FOR UPDATE OF evidence;
  PERFORM 1 FROM dasher.field_catalog_snapshots AS catalog
  WHERE catalog.organization_id = v_organization_id AND catalog.dashboard_id = $1
  ORDER BY pg_catalog.uuid_send(catalog.catalog_snapshot_id) FOR UPDATE OF catalog;
  PERFORM 1 FROM dasher.field_catalog_entries AS entry
  WHERE entry.organization_id = v_organization_id AND entry.dashboard_id = $1
  ORDER BY pg_catalog.uuid_send(entry.catalog_snapshot_id), entry.field_id FOR UPDATE OF entry;
  PERFORM 1 FROM dasher.metric_contract_versions AS contract
  WHERE contract.organization_id = v_organization_id AND contract.dashboard_id = $1
  ORDER BY pg_catalog.uuid_send(contract.contract_id), contract.contract_version FOR UPDATE OF contract;
  PERFORM 1 FROM dasher.agent_run_request_payloads AS request_payload
  WHERE request_payload.organization_id = v_organization_id AND request_payload.dashboard_id = $1
  ORDER BY pg_catalog.uuid_send(request_payload.request_payload_id) FOR UPDATE OF request_payload;
  PERFORM 1 FROM dasher.agent_run_events AS event
  WHERE event.organization_id = v_organization_id AND event.dashboard_id = $1
  ORDER BY pg_catalog.uuid_send(event.run_id), event.event_sequence FOR UPDATE OF event;
  PERFORM 1 FROM dasher.agent_run_checkpoints AS checkpoint
  WHERE checkpoint.organization_id = v_organization_id AND checkpoint.dashboard_id = $1
  ORDER BY pg_catalog.uuid_send(checkpoint.run_id), checkpoint.checkpoint_revision FOR UPDATE OF checkpoint;
  PERFORM 1 FROM dasher.agent_run_checkpoint_payloads AS checkpoint_payload
  WHERE checkpoint_payload.organization_id = v_organization_id AND checkpoint_payload.dashboard_id = $1
  ORDER BY pg_catalog.uuid_send(checkpoint_payload.checkpoint_payload_id) FOR UPDATE OF checkpoint_payload;
  PERFORM 1 FROM dasher.candidate_comparison_bundles AS bundle
  WHERE bundle.organization_id = v_organization_id AND bundle.dashboard_id = $1
  ORDER BY pg_catalog.uuid_send(bundle.run_id), pg_catalog.uuid_send(bundle.bundle_id) FOR UPDATE OF bundle;
  SELECT pg_catalog.sha256(
    pg_catalog.convert_to('dasher.bundle-membership-retention-snapshot.v1', 'UTF8')
    || pg_catalog.decode('00', 'hex')
    || pg_catalog.convert_to(COALESCE(pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_array(member.run_id, member.bundle_id, member.evidence_id)
      ORDER BY pg_catalog.uuid_send(member.run_id),
        pg_catalog.uuid_send(member.bundle_id), pg_catalog.uuid_send(member.evidence_id)
    )::text, '[]'), 'UTF8')
  ) INTO v_bundle_membership_sha256
  FROM dasher.candidate_comparison_bundle_evidence AS member
  WHERE member.organization_id = v_organization_id AND member.dashboard_id = $1;
  PERFORM 1 FROM dasher.briefs AS brief
  WHERE brief.organization_id = v_organization_id AND brief.dashboard_id = $1
  ORDER BY pg_catalog.uuid_send(brief.run_id), pg_catalog.uuid_send(brief.brief_id) FOR UPDATE OF brief;
  PERFORM 1 FROM dasher.agent_run_budget_counters AS counter
  WHERE counter.organization_id = v_organization_id AND counter.dashboard_id = $1
  ORDER BY pg_catalog.uuid_send(counter.run_id), counter.partition FOR UPDATE OF counter;
  PERFORM 1 FROM dasher.agent_run_attempts AS run_attempt
  WHERE run_attempt.organization_id = v_organization_id AND run_attempt.dashboard_id = $1
  ORDER BY pg_catalog.uuid_send(run_attempt.run_id), pg_catalog.uuid_send(run_attempt.attempt_id) FOR UPDATE OF run_attempt;
  PERFORM 1 FROM dasher.agent_run_attempt_payloads AS attempt_payload
  WHERE attempt_payload.organization_id = v_organization_id AND attempt_payload.dashboard_id = $1
  ORDER BY pg_catalog.uuid_send(attempt_payload.run_id), pg_catalog.uuid_send(attempt_payload.attempt_id), attempt_payload.payload_kind, pg_catalog.uuid_send(attempt_payload.payload_id) FOR UPDATE OF attempt_payload;
  PERFORM 1 FROM dasher.agent_recorded_results AS recorded_result
  WHERE recorded_result.organization_id = v_organization_id AND recorded_result.dashboard_id = $1
  ORDER BY pg_catalog.uuid_send(recorded_result.run_id), recorded_result.result_sequence FOR UPDATE OF recorded_result;
  PERFORM 1 FROM dasher.calculation_graphs AS graph
  WHERE graph.organization_id = v_organization_id AND graph.dashboard_id = $1
  ORDER BY pg_catalog.uuid_send(graph.run_id), pg_catalog.uuid_send(graph.graph_id) FOR UPDATE OF graph;
  PERFORM 1 FROM dasher.calculation_results AS calculation_result
  WHERE calculation_result.organization_id = v_organization_id AND calculation_result.dashboard_id = $1
  ORDER BY pg_catalog.uuid_send(calculation_result.run_id), pg_catalog.uuid_send(calculation_result.result_id) FOR UPDATE OF calculation_result;
  PERFORM 1 FROM dasher.agent_run_calculation_meters AS meter
  WHERE meter.organization_id = v_organization_id AND meter.dashboard_id = $1
  ORDER BY pg_catalog.uuid_send(meter.run_id), pg_catalog.uuid_send(meter.meter_id) FOR UPDATE OF meter;
  PERFORM 1 FROM dasher.agent_candidates AS candidate
  WHERE candidate.organization_id = v_organization_id AND candidate.dashboard_id = $1
  ORDER BY pg_catalog.uuid_send(candidate.run_id), pg_catalog.uuid_send(candidate.candidate_id) FOR UPDATE OF candidate;
  PERFORM 1 FROM dasher.agent_candidate_payloads AS candidate_payload
  WHERE candidate_payload.organization_id = v_organization_id AND candidate_payload.dashboard_id = $1
  ORDER BY pg_catalog.uuid_send(candidate_payload.run_id), pg_catalog.uuid_send(candidate_payload.candidate_id) FOR UPDATE OF candidate_payload;
  PERFORM 1 FROM dasher.agent_validation_findings AS finding
  WHERE finding.organization_id = v_organization_id AND finding.dashboard_id = $1
  ORDER BY pg_catalog.uuid_send(finding.run_id), pg_catalog.uuid_send(finding.candidate_id) FOR UPDATE OF finding;
  PERFORM 1 FROM dasher.claims AS semantic_claim
  WHERE semantic_claim.organization_id = v_organization_id AND semantic_claim.dashboard_id = $1
  ORDER BY pg_catalog.uuid_send(semantic_claim.run_id), pg_catalog.uuid_send(semantic_claim.candidate_id), pg_catalog.uuid_send(semantic_claim.claim_id) FOR UPDATE OF semantic_claim;
  PERFORM 1 FROM dasher.claim_evidence AS claim_edge
  WHERE claim_edge.organization_id = v_organization_id AND claim_edge.dashboard_id = $1
  ORDER BY pg_catalog.uuid_send(claim_edge.run_id), pg_catalog.uuid_send(claim_edge.candidate_id), pg_catalog.uuid_send(claim_edge.claim_id), pg_catalog.uuid_send(claim_edge.bundle_id), pg_catalog.uuid_send(claim_edge.evidence_id), claim_edge.relation FOR UPDATE OF claim_edge;
  PERFORM 1 FROM dasher.candidate_evidence_manifests AS manifest
  WHERE manifest.organization_id = v_organization_id AND manifest.dashboard_id = $1
  ORDER BY pg_catalog.uuid_send(manifest.run_id), pg_catalog.uuid_send(manifest.candidate_id) FOR UPDATE OF manifest;
  PERFORM 1 FROM dasher.run_abstentions AS abstention
  WHERE abstention.organization_id = v_organization_id AND abstention.dashboard_id = $1
  ORDER BY pg_catalog.uuid_send(abstention.run_id) FOR UPDATE OF abstention;
  PERFORM 1 FROM dasher.dashboard_cleanup_attempts AS cleanup_attempt
  WHERE cleanup_attempt.organization_id = v_organization_id AND cleanup_attempt.dashboard_id = $1
  ORDER BY cleanup_attempt.finished_at, pg_catalog.uuid_send(cleanup_attempt.cleanup_attempt_id) FOR UPDATE OF cleanup_attempt;
  PERFORM 1 FROM dasher.dashboard_agent_drain_proofs AS drain_proof
  WHERE drain_proof.organization_id = v_organization_id AND drain_proof.dashboard_id = $1
  ORDER BY drain_proof.generated_at, pg_catalog.uuid_send(drain_proof.proof_id) FOR UPDATE OF drain_proof;
  PERFORM 1 FROM dasher.dashboard_agent_drain_proof_consumptions AS drain_consumption
  WHERE drain_consumption.organization_id = v_organization_id AND drain_consumption.dashboard_id = $1
  ORDER BY drain_consumption.consumed_at, pg_catalog.uuid_send(drain_consumption.proof_id) FOR UPDATE OF drain_consumption;
  v_expected := dasher_private.recompute_cleanup_completion_proof_v1(
    v_organization_id, $1
  );
  IF $3 IS NULL OR $3 <> v_expected
    OR NOT dasher_private.verify_phase7_content_purge_fk_dag_v1(
      v_organization_id, $1
    )
    OR NOT EXISTS (
      SELECT 1 FROM dasher.dashboard_cleanup_attempts AS attempt
      WHERE attempt.organization_id = v_organization_id
        AND attempt.dashboard_id = $1
        AND attempt.step = 'purge_finalizing'
        AND attempt.result IN ('succeeded', 'already_complete')
        AND attempt.proof_sha256 = $3
      ORDER BY attempt.finished_at DESC,
        pg_catalog.uuid_send(attempt.cleanup_attempt_id) DESC LIMIT 1
    )
    OR NOT EXISTS (
      SELECT 1
      FROM dasher.dashboard_agent_drain_proofs AS proof
      JOIN dasher.dashboard_agent_drain_proof_consumptions AS consumed
        ON consumed.organization_id = proof.organization_id
       AND consumed.dashboard_id = proof.dashboard_id
       AND consumed.proof_id = proof.proof_id
       AND consumed.drain_proof_sha256 = proof.drain_proof_sha256
      WHERE proof.organization_id = v_organization_id
        AND proof.dashboard_id = $1 AND proof.lifecycle_revision = $2
        AND proof.remaining_nonterminal_run_count = 0
        AND proof.remaining_claimed_run_count = 0
        AND proof.drain_proof_sha256 =
          dasher_private.recompute_drain_proof_v1(v_organization_id, $1)
        AND consumed.consumption_sha256 =
          dasher_private.recompute_drain_consumption_v1(v_organization_id, $1)
        AND proof.proof_id = (
          SELECT latest.proof_id FROM dasher.dashboard_agent_drain_proofs AS latest
          WHERE latest.organization_id = v_organization_id
            AND latest.dashboard_id = $1
          ORDER BY latest.generated_at DESC,
            pg_catalog.uuid_send(latest.proof_id) DESC LIMIT 1
        )
    )
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;

  IF v_dashboard.purge_started_at IS NULL THEN
    UPDATE dasher.dashboards
    SET purge_started_at = v_now, head_version_id = NULL
    WHERE organization_id = v_organization_id AND dashboard_id = $1
      AND lifecycle_revision = $2 AND purge_started_at IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
    END IF;
    INSERT INTO dasher.dashboard_cleanup_attempts (
      organization_id, dashboard_id, cleanup_attempt_id, step, started_at,
      finished_at, result, released_claim_count, deleted_resource_count,
      deferred_claim_count, failure_code, proof_sha256
    ) VALUES (v_organization_id, $1, $4, 'purge_started', v_now, v_now,
      'outstanding_reference', 0, 0, 0, NULL, NULL);
    UPDATE dasher.dashboard_cleanup_coordination
    SET current_step = 'purge_started', lease_owner = NULL,
      lease_expires_at = NULL, expected_lifecycle_revision = $2,
      next_attempt_at = v_now, completion_proof_sha256 = NULL
    WHERE organization_id = v_organization_id AND dashboard_id = $1;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
    END IF;
    RETURN;
  END IF;

  IF $3 IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  IF v_coordination.expected_lifecycle_revision <> $2
    OR v_coordination.completion_proof_sha256 IS NULL
    OR v_coordination.completion_proof_sha256 <> $3
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  IF v_coordination.completion_proof_sha256 IS NULL THEN
    UPDATE dasher.dashboard_cleanup_coordination
    SET current_step = 'purge_finalizing', completion_proof_sha256 = $3,
      expected_lifecycle_revision = $2, next_attempt_at = v_now
    WHERE organization_id = v_organization_id AND dashboard_id = $1
      AND expected_lifecycle_revision = $2
      AND completion_proof_sha256 IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
    END IF;
  END IF;

  v_snapshot_ids := ARRAY(
    SELECT snapshot.snapshot_id
    FROM dasher.source_snapshots AS snapshot
    WHERE snapshot.organization_id = v_organization_id
      AND EXISTS (
        SELECT 1 FROM dasher.dashboard_version_snapshots AS link
        WHERE link.organization_id = snapshot.organization_id
          AND link.dashboard_id = $1
          AND link.snapshot_id = snapshot.snapshot_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM dasher.snapshot_deletion_finalizers AS existing
        WHERE existing.organization_id = snapshot.organization_id
          AND existing.snapshot_id = snapshot.snapshot_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM dasher.snapshot_reference_claims AS other_claim
        WHERE other_claim.organization_id = snapshot.organization_id
          AND other_claim.snapshot_id = snapshot.snapshot_id
          AND NOT (other_claim.dashboard_id = $1
            AND other_claim.claim_kind = 'access_bearing'
            AND other_claim.hold_id IS NULL)
      )
      AND NOT EXISTS (
        SELECT 1 FROM dasher.evidence_records AS related_evidence
        JOIN dasher.evidence_reference_claims AS evidence_claim
          ON evidence_claim.organization_id = related_evidence.organization_id
         AND evidence_claim.evidence_id = related_evidence.evidence_id
        WHERE related_evidence.organization_id = snapshot.organization_id
          AND related_evidence.snapshot_id = snapshot.snapshot_id
          AND NOT (evidence_claim.dashboard_id = $1
            AND evidence_claim.claim_kind = 'access_bearing'
            AND evidence_claim.hold_id IS NULL)
      )
    ORDER BY snapshot.snapshot_id
    LIMIT v_batch_limit
    FOR UPDATE OF snapshot
  );
  PERFORM 1 FROM dasher.snapshot_reference_claims AS claim
  WHERE claim.organization_id = v_organization_id
    AND claim.snapshot_id = ANY(v_snapshot_ids)
  ORDER BY claim.snapshot_id, claim.reference_claim_id
  FOR UPDATE OF claim;
  PERFORM 1 FROM dasher.evidence_reference_claims AS evidence_claim
  JOIN dasher.evidence_records AS related_evidence
    ON related_evidence.organization_id = evidence_claim.organization_id
   AND related_evidence.evidence_id = evidence_claim.evidence_id
  WHERE related_evidence.organization_id = v_organization_id
    AND related_evidence.snapshot_id = ANY(v_snapshot_ids)
  ORDER BY evidence_claim.evidence_id, evidence_claim.reference_claim_id
  FOR UPDATE OF evidence_claim;
  INSERT INTO dasher.snapshot_deletion_finalizers (
    organization_id, snapshot_id, state, intent_at,
    expected_claim_set_sha256
  ) SELECT v_organization_id, candidate.snapshot_id, 'intent', v_now,
      sha256(uuid_send(v_organization_id) || uuid_send($1)
        || uuid_send(candidate.snapshot_id) || convert_to('snapshot|expected_claim_set=empty', 'UTF8'))
    FROM unnest(v_snapshot_ids) AS candidate(snapshot_id)
    WHERE NOT EXISTS (
        SELECT 1 FROM dasher.snapshot_deletion_finalizers AS existing
        WHERE existing.organization_id = v_organization_id
          AND existing.snapshot_id = candidate.snapshot_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM dasher.snapshot_reference_claims AS other_claim
        WHERE other_claim.organization_id = v_organization_id
          AND other_claim.snapshot_id = candidate.snapshot_id
          AND NOT (other_claim.dashboard_id = $1
            AND other_claim.claim_kind = 'access_bearing'
            AND other_claim.hold_id IS NULL)
      )
      AND NOT EXISTS (
        SELECT 1 FROM dasher.evidence_records AS related_evidence
        JOIN dasher.evidence_reference_claims AS evidence_claim
          ON evidence_claim.organization_id = related_evidence.organization_id
         AND evidence_claim.evidence_id = related_evidence.evidence_id
        WHERE related_evidence.organization_id = v_organization_id
          AND related_evidence.snapshot_id = candidate.snapshot_id
          AND NOT (evidence_claim.dashboard_id = $1
            AND evidence_claim.claim_kind = 'access_bearing'
            AND evidence_claim.hold_id IS NULL)
      )
    ORDER BY candidate.snapshot_id
  ON CONFLICT (organization_id, snapshot_id) DO NOTHING;
  GET DIAGNOSTICS v_row_count = ROW_COUNT;
  IF v_row_count > 0 THEN RETURN; END IF;

  v_evidence_ids := ARRAY(
    SELECT evidence.evidence_id
    FROM dasher.evidence_records AS evidence
    WHERE evidence.organization_id = v_organization_id
      AND EXISTS (
        SELECT 1 FROM dasher.dashboard_version_evidence AS link
        WHERE link.organization_id = evidence.organization_id
          AND link.dashboard_id = $1
          AND link.evidence_id = evidence.evidence_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM dasher.evidence_deletion_finalizers AS existing
        WHERE existing.organization_id = evidence.organization_id
          AND existing.evidence_id = evidence.evidence_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM dasher.evidence_reference_claims AS other_claim
        WHERE other_claim.organization_id = evidence.organization_id
          AND other_claim.evidence_id = evidence.evidence_id
          AND NOT (other_claim.dashboard_id = $1
            AND other_claim.claim_kind = 'access_bearing'
            AND other_claim.hold_id IS NULL)
      )
    ORDER BY evidence.evidence_id
    LIMIT v_batch_limit
    FOR UPDATE OF evidence
  );
  PERFORM 1 FROM dasher.evidence_reference_claims AS claim
  WHERE claim.organization_id = v_organization_id
    AND claim.evidence_id = ANY(v_evidence_ids)
  ORDER BY claim.evidence_id, claim.reference_claim_id
  FOR UPDATE OF claim;
  INSERT INTO dasher.evidence_deletion_finalizers (
    organization_id, evidence_id, state, intent_at,
    expected_claim_set_sha256
  ) SELECT v_organization_id, candidate.evidence_id, 'intent', v_now,
      sha256(uuid_send(v_organization_id) || uuid_send($1)
        || uuid_send(candidate.evidence_id) || convert_to('evidence|expected_claim_set=empty', 'UTF8'))
    FROM unnest(v_evidence_ids) AS candidate(evidence_id)
    WHERE NOT EXISTS (
        SELECT 1 FROM dasher.evidence_deletion_finalizers AS existing
        WHERE existing.organization_id = v_organization_id
          AND existing.evidence_id = candidate.evidence_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM dasher.evidence_reference_claims AS other_claim
        WHERE other_claim.organization_id = v_organization_id
          AND other_claim.evidence_id = candidate.evidence_id
          AND NOT (other_claim.dashboard_id = $1
            AND other_claim.claim_kind = 'access_bearing'
            AND other_claim.hold_id IS NULL)
      )
    ORDER BY candidate.evidence_id
  ON CONFLICT (organization_id, evidence_id) DO NOTHING;
  GET DIAGNOSTICS v_row_count = ROW_COUNT;
  IF v_row_count > 0 THEN RETURN; END IF;

  v_artifact_ids := ARRAY(
    SELECT artifact.artifact_id
    FROM dasher.dashboard_artifacts AS artifact
    WHERE artifact.organization_id = v_organization_id
      AND (
        (artifact.ownership_class = 'dashboard_owned'
          AND artifact.dashboard_id = $1)
        OR
        (artifact.ownership_class = 'shared' AND EXISTS (
          SELECT 1 FROM dasher.artifact_reference_claims AS target_claim
          WHERE target_claim.organization_id = artifact.organization_id
            AND target_claim.artifact_id = artifact.artifact_id
            AND target_claim.dashboard_id = $1
            AND target_claim.claim_kind = 'access_bearing'
            AND target_claim.hold_id IS NULL
        ))
      )
      AND NOT EXISTS (
        SELECT 1 FROM dasher.artifact_deletion_finalizers AS existing
        WHERE existing.organization_id = artifact.organization_id
          AND existing.artifact_id = artifact.artifact_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM dasher.artifact_reference_claims AS other_claim
        WHERE other_claim.organization_id = artifact.organization_id
          AND other_claim.artifact_id = artifact.artifact_id
          AND NOT (other_claim.dashboard_id = $1
            AND other_claim.claim_kind = 'access_bearing'
            AND other_claim.hold_id IS NULL)
      )
    ORDER BY artifact.artifact_id
    LIMIT v_batch_limit
    FOR UPDATE OF artifact
  );
  PERFORM 1 FROM dasher.artifact_reference_claims AS claim
  WHERE claim.organization_id = v_organization_id
    AND claim.artifact_id = ANY(v_artifact_ids)
  ORDER BY claim.artifact_id, claim.reference_claim_id
  FOR UPDATE OF claim;
  INSERT INTO dasher.artifact_deletion_finalizers (
    organization_id, artifact_id, state, intent_at,
    expected_claim_set_sha256
  ) SELECT v_organization_id, candidate.artifact_id, 'intent', v_now,
      sha256(uuid_send(v_organization_id) || uuid_send($1)
        || uuid_send(candidate.artifact_id) || convert_to('artifact|expected_claim_set=empty', 'UTF8'))
    FROM unnest(v_artifact_ids) AS candidate(artifact_id)
    WHERE EXISTS (
        SELECT 1 FROM dasher.dashboard_artifacts AS artifact
        WHERE artifact.organization_id = v_organization_id
          AND artifact.artifact_id = candidate.artifact_id
          AND (
            (artifact.ownership_class = 'dashboard_owned'
              AND artifact.dashboard_id = $1)
            OR
            (artifact.ownership_class = 'shared' AND EXISTS (
              SELECT 1 FROM dasher.artifact_reference_claims AS target_claim
              WHERE target_claim.organization_id = artifact.organization_id
                AND target_claim.artifact_id = artifact.artifact_id
                AND target_claim.dashboard_id = $1
                AND target_claim.claim_kind = 'access_bearing'
                AND target_claim.hold_id IS NULL
            ))
          )
      )
      AND NOT EXISTS (
        SELECT 1 FROM dasher.artifact_deletion_finalizers AS existing
        WHERE existing.organization_id = v_organization_id
          AND existing.artifact_id = candidate.artifact_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM dasher.artifact_reference_claims AS other_claim
        WHERE other_claim.organization_id = v_organization_id
          AND other_claim.artifact_id = candidate.artifact_id
          AND NOT (other_claim.dashboard_id = $1
            AND other_claim.claim_kind = 'access_bearing'
            AND other_claim.hold_id IS NULL)
      )
    ORDER BY candidate.artifact_id
  ON CONFLICT (organization_id, artifact_id) DO NOTHING;
  GET DIAGNOSTICS v_row_count = ROW_COUNT;
  IF v_row_count > 0 THEN RETURN; END IF;

  SELECT snapshot.snapshot_id INTO v_gap_snapshot_id
  FROM dasher.source_snapshots AS snapshot
  WHERE snapshot.organization_id = v_organization_id
    AND EXISTS (
      SELECT 1 FROM dasher.dashboard_version_snapshots AS link
      WHERE link.organization_id = snapshot.organization_id
        AND link.dashboard_id = $1
        AND link.snapshot_id = snapshot.snapshot_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM dasher.snapshot_deletion_finalizers AS finalizer
      WHERE finalizer.organization_id = snapshot.organization_id
        AND finalizer.snapshot_id = snapshot.snapshot_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM dasher.snapshot_reference_claims AS other_claim
      WHERE other_claim.organization_id = snapshot.organization_id
        AND other_claim.snapshot_id = snapshot.snapshot_id
        AND NOT (other_claim.dashboard_id = $1
          AND other_claim.claim_kind = 'access_bearing'
          AND other_claim.hold_id IS NULL)
    )
    AND NOT EXISTS (
      SELECT 1 FROM dasher.evidence_records AS related_evidence
      JOIN dasher.evidence_reference_claims AS evidence_claim
        ON evidence_claim.organization_id = related_evidence.organization_id
       AND evidence_claim.evidence_id = related_evidence.evidence_id
      WHERE related_evidence.organization_id = snapshot.organization_id
        AND related_evidence.snapshot_id = snapshot.snapshot_id
        AND NOT (evidence_claim.dashboard_id = $1
          AND evidence_claim.claim_kind = 'access_bearing'
          AND evidence_claim.hold_id IS NULL)
    )
  ORDER BY snapshot.snapshot_id
  LIMIT 1
  FOR UPDATE OF snapshot;
  IF v_gap_snapshot_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM dasher.source_snapshots AS snapshot
    WHERE snapshot.organization_id = v_organization_id
      AND snapshot.snapshot_id = v_gap_snapshot_id
      AND EXISTS (
        SELECT 1 FROM dasher.dashboard_version_snapshots AS link
        WHERE link.organization_id = snapshot.organization_id
          AND link.dashboard_id = $1
          AND link.snapshot_id = snapshot.snapshot_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM dasher.snapshot_deletion_finalizers AS finalizer
        WHERE finalizer.organization_id = snapshot.organization_id
          AND finalizer.snapshot_id = snapshot.snapshot_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM dasher.snapshot_reference_claims AS other_claim
        WHERE other_claim.organization_id = snapshot.organization_id
          AND other_claim.snapshot_id = snapshot.snapshot_id
          AND NOT (other_claim.dashboard_id = $1
            AND other_claim.claim_kind = 'access_bearing'
            AND other_claim.hold_id IS NULL)
      )
      AND NOT EXISTS (
        SELECT 1 FROM dasher.evidence_records AS related_evidence
        JOIN dasher.evidence_reference_claims AS evidence_claim
          ON evidence_claim.organization_id = related_evidence.organization_id
         AND evidence_claim.evidence_id = related_evidence.evidence_id
        WHERE related_evidence.organization_id = snapshot.organization_id
          AND related_evidence.snapshot_id = snapshot.snapshot_id
          AND NOT (evidence_claim.dashboard_id = $1
            AND evidence_claim.claim_kind = 'access_bearing'
            AND evidence_claim.hold_id IS NULL)
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;

  SELECT evidence.evidence_id INTO v_gap_evidence_id
  FROM dasher.evidence_records AS evidence
  WHERE evidence.organization_id = v_organization_id
    AND EXISTS (
      SELECT 1 FROM dasher.dashboard_version_evidence AS link
      WHERE link.organization_id = evidence.organization_id
        AND link.dashboard_id = $1
        AND link.evidence_id = evidence.evidence_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM dasher.evidence_deletion_finalizers AS finalizer
      WHERE finalizer.organization_id = evidence.organization_id
        AND finalizer.evidence_id = evidence.evidence_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM dasher.evidence_reference_claims AS other_claim
      WHERE other_claim.organization_id = evidence.organization_id
        AND other_claim.evidence_id = evidence.evidence_id
        AND NOT (other_claim.dashboard_id = $1
          AND other_claim.claim_kind = 'access_bearing'
          AND other_claim.hold_id IS NULL)
    )
  ORDER BY evidence.evidence_id
  LIMIT 1
  FOR UPDATE OF evidence;
  IF v_gap_evidence_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM dasher.evidence_records AS evidence
    WHERE evidence.organization_id = v_organization_id
      AND evidence.evidence_id = v_gap_evidence_id
      AND EXISTS (
        SELECT 1 FROM dasher.dashboard_version_evidence AS link
        WHERE link.organization_id = evidence.organization_id
          AND link.dashboard_id = $1
          AND link.evidence_id = evidence.evidence_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM dasher.evidence_deletion_finalizers AS finalizer
        WHERE finalizer.organization_id = evidence.organization_id
          AND finalizer.evidence_id = evidence.evidence_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM dasher.evidence_reference_claims AS other_claim
        WHERE other_claim.organization_id = evidence.organization_id
          AND other_claim.evidence_id = evidence.evidence_id
          AND NOT (other_claim.dashboard_id = $1
            AND other_claim.claim_kind = 'access_bearing'
            AND other_claim.hold_id IS NULL)
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;

  SELECT artifact.artifact_id INTO v_gap_artifact_id
  FROM dasher.dashboard_artifacts AS artifact
  WHERE artifact.organization_id = v_organization_id
    AND (
      (artifact.ownership_class = 'dashboard_owned'
        AND artifact.dashboard_id = $1)
      OR
      (artifact.ownership_class = 'shared' AND EXISTS (
        SELECT 1 FROM dasher.artifact_reference_claims AS target_claim
        WHERE target_claim.organization_id = artifact.organization_id
          AND target_claim.artifact_id = artifact.artifact_id
          AND target_claim.dashboard_id = $1
          AND target_claim.claim_kind = 'access_bearing'
          AND target_claim.hold_id IS NULL
      ))
    )
    AND NOT EXISTS (
      SELECT 1 FROM dasher.artifact_deletion_finalizers AS finalizer
      WHERE finalizer.organization_id = artifact.organization_id
        AND finalizer.artifact_id = artifact.artifact_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM dasher.artifact_reference_claims AS other_claim
      WHERE other_claim.organization_id = artifact.organization_id
        AND other_claim.artifact_id = artifact.artifact_id
        AND NOT (other_claim.dashboard_id = $1
          AND other_claim.claim_kind = 'access_bearing'
          AND other_claim.hold_id IS NULL)
    )
  ORDER BY artifact.artifact_id
  LIMIT 1
  FOR UPDATE OF artifact;
  IF v_gap_artifact_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM dasher.dashboard_artifacts AS artifact
    WHERE artifact.organization_id = v_organization_id
      AND artifact.artifact_id = v_gap_artifact_id
      AND (
        (artifact.ownership_class = 'dashboard_owned'
          AND artifact.dashboard_id = $1)
        OR
        (artifact.ownership_class = 'shared' AND EXISTS (
          SELECT 1 FROM dasher.artifact_reference_claims AS target_claim
          WHERE target_claim.organization_id = artifact.organization_id
            AND target_claim.artifact_id = artifact.artifact_id
            AND target_claim.dashboard_id = $1
            AND target_claim.claim_kind = 'access_bearing'
            AND target_claim.hold_id IS NULL
        ))
      )
      AND NOT EXISTS (
        SELECT 1 FROM dasher.artifact_deletion_finalizers AS finalizer
        WHERE finalizer.organization_id = artifact.organization_id
          AND finalizer.artifact_id = artifact.artifact_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM dasher.artifact_reference_claims AS other_claim
        WHERE other_claim.organization_id = artifact.organization_id
          AND other_claim.artifact_id = artifact.artifact_id
          AND NOT (other_claim.dashboard_id = $1
            AND other_claim.claim_kind = 'access_bearing'
            AND other_claim.hold_id IS NULL)
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;

  -- Pointer-first phase-7 content purge precedes predecessor source/evidence DML.
  v_phase7_expected_counts := pg_catalog.jsonb_build_object(
    'candidate_evidence_manifests', (SELECT pg_catalog.count(*) FROM dasher.candidate_evidence_manifests
      WHERE organization_id = v_organization_id AND dashboard_id = $1),
    'claim_evidence', (SELECT pg_catalog.count(*) FROM dasher.claim_evidence
      WHERE organization_id = v_organization_id AND dashboard_id = $1),
    'claims', (SELECT pg_catalog.count(*) FROM dasher.claims
      WHERE organization_id = v_organization_id AND dashboard_id = $1),
    'agent_validation_findings', (SELECT pg_catalog.count(*) FROM dasher.agent_validation_findings
      WHERE organization_id = v_organization_id AND dashboard_id = $1),
    'agent_candidate_payloads', (SELECT pg_catalog.count(*) FROM dasher.agent_candidate_payloads
      WHERE organization_id = v_organization_id AND dashboard_id = $1),
    'agent_candidates', (SELECT pg_catalog.count(*) FROM dasher.agent_candidates
      WHERE organization_id = v_organization_id AND dashboard_id = $1),
    'agent_run_calculation_meters', (SELECT pg_catalog.count(*) FROM dasher.agent_run_calculation_meters
      WHERE organization_id = v_organization_id AND dashboard_id = $1),
    'calculation_results', (SELECT pg_catalog.count(*) FROM dasher.calculation_results
      WHERE organization_id = v_organization_id AND dashboard_id = $1),
    'calculation_graphs', (SELECT pg_catalog.count(*) FROM dasher.calculation_graphs
      WHERE organization_id = v_organization_id AND dashboard_id = $1),
    'briefs', (SELECT pg_catalog.count(*) FROM dasher.briefs
      WHERE organization_id = v_organization_id AND dashboard_id = $1),
    'run_abstentions', (SELECT pg_catalog.count(*) FROM dasher.run_abstentions
      WHERE organization_id = v_organization_id AND dashboard_id = $1),
    'candidate_comparison_bundle_evidence', (SELECT pg_catalog.count(*) FROM dasher.candidate_comparison_bundle_evidence
      WHERE organization_id = v_organization_id AND dashboard_id = $1),
    'candidate_comparison_bundles', (SELECT pg_catalog.count(*) FROM dasher.candidate_comparison_bundles
      WHERE organization_id = v_organization_id AND dashboard_id = $1),
    'agent_recorded_results', (SELECT pg_catalog.count(*) FROM dasher.agent_recorded_results
      WHERE organization_id = v_organization_id AND dashboard_id = $1),
    'agent_run_request_payloads', (SELECT pg_catalog.count(*) FROM dasher.agent_run_request_payloads
      WHERE organization_id = v_organization_id AND dashboard_id = $1),
    'agent_run_attempt_payloads', (SELECT pg_catalog.count(*) FROM dasher.agent_run_attempt_payloads
      WHERE organization_id = v_organization_id AND dashboard_id = $1),
    'agent_run_checkpoint_payloads', (SELECT pg_catalog.count(*) FROM dasher.agent_run_checkpoint_payloads
      WHERE organization_id = v_organization_id AND dashboard_id = $1),
    'agent_run_event_payloads', (SELECT pg_catalog.count(*)
      FROM dasher.agent_run_events AS event
      WHERE event.organization_id = v_organization_id
        AND event.dashboard_id = $1 AND event.event_payload_id IS NOT NULL),
    'metric_contract_versions', (SELECT pg_catalog.count(*) FROM dasher.metric_contract_versions
      WHERE organization_id = v_organization_id AND dashboard_id = $1),
    'field_catalog_entries', (SELECT pg_catalog.count(*) FROM dasher.field_catalog_entries
      WHERE organization_id = v_organization_id AND dashboard_id = $1),
    'field_catalog_snapshots', (SELECT pg_catalog.count(*) FROM dasher.field_catalog_snapshots
      WHERE organization_id = v_organization_id AND dashboard_id = $1)
  );
  IF EXISTS (
    SELECT 1 FROM dasher.agent_runs AS run
    WHERE run.organization_id = v_organization_id AND run.dashboard_id = $1
      AND (run.state NOT IN ('rejected','cancelled','expired','failed','approval_required')
        OR run.lease_token_sha256 IS NOT NULL
        OR run.lease_owner_principal_id IS NOT NULL
        OR run.lease_owner_principal_revision IS NOT NULL
        OR run.lease_expires_at IS NOT NULL)
  ) OR EXISTS (
    SELECT 1 FROM dasher.agent_run_attempts AS attempt
    WHERE attempt.organization_id = v_organization_id AND attempt.dashboard_id = $1
      AND (attempt.state NOT IN (
        'succeeded','refused_charged','failed_charged','released_pre_dispatch',
        'cancelled_released','cancelled_charged','indeterminate_charged'
      ) OR (attempt.outstanding_vector).calls <> 0
        OR (attempt.outstanding_vector).candidates <> 0
        OR (attempt.outstanding_vector).specialist_attempts <> 0
        OR (attempt.outstanding_vector).reviewer_attempts <> 0
        OR (attempt.outstanding_vector).repair_attempts <> 0
        OR (attempt.outstanding_vector).input_tokens <> 0
        OR (attempt.outstanding_vector).output_tokens <> 0
        OR (attempt.outstanding_vector).reasoning_tokens <> 0
        OR (attempt.outstanding_vector).cache_read_tokens <> 0
        OR (attempt.outstanding_vector).cache_write_tokens <> 0
        OR (attempt.outstanding_vector).total_tokens <> 0
        OR (attempt.outstanding_vector).wall_millis <> 0
        OR (attempt.outstanding_vector).work_millis <> 0
        OR (attempt.outstanding_vector).cost_micros <> 0)
  ) OR EXISTS (
    SELECT 1 FROM dasher.agent_run_budget_counters AS counter
    WHERE counter.organization_id = v_organization_id AND counter.dashboard_id = $1
      AND counter.reserved_units <>
        counter.used_units + counter.released_units
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;

  UPDATE dasher.agent_runs AS run SET request_payload_id = NULL,
    candidate_set_sha256 = NULL, terminal_reason_sha256 = NULL,
    selected_candidate_id = NULL, consumed_replay_sequence = NULL,
    consumed_replay_sha256 = NULL, terminal_claim_input_sha256 = NULL,
    terminal_operation_sha256 = NULL
  WHERE run.organization_id = v_organization_id AND run.dashboard_id = $1
    AND (run.request_payload_id IS NOT NULL OR run.candidate_set_sha256 IS NOT NULL
      OR run.terminal_reason_sha256 IS NOT NULL OR run.selected_candidate_id IS NOT NULL
      OR run.consumed_replay_sequence IS NOT NULL OR run.consumed_replay_sha256 IS NOT NULL
      OR run.terminal_claim_input_sha256 IS NOT NULL OR run.terminal_operation_sha256 IS NOT NULL);
  UPDATE dasher.agent_run_events AS event SET event_payload_id = NULL,
    claim_input_sha256 = NULL, claim_result_sha256 = NULL,
    claim_result_attempt_token = NULL, claim_result_input_sha256 = NULL
  WHERE event.organization_id = v_organization_id AND event.dashboard_id = $1
    AND (event.event_payload_id IS NOT NULL OR event.claim_input_sha256 IS NOT NULL
      OR event.claim_result_sha256 IS NOT NULL OR event.claim_result_attempt_token IS NOT NULL
      OR event.claim_result_input_sha256 IS NOT NULL);
  UPDATE dasher.agent_run_checkpoints AS checkpoint SET state_sha256 = NULL,
    checkpoint_payload_id = NULL
  WHERE checkpoint.organization_id = v_organization_id AND checkpoint.dashboard_id = $1
    AND (checkpoint.state_sha256 IS NOT NULL OR checkpoint.checkpoint_payload_id IS NOT NULL);
  UPDATE dasher.agent_run_attempts AS attempt SET request_payload_id = NULL,
    result_payload_id = NULL, terminal_reason_sha256 = NULL
  WHERE attempt.organization_id = v_organization_id AND attempt.dashboard_id = $1
    AND (attempt.request_payload_id IS NOT NULL OR attempt.result_payload_id IS NOT NULL
      OR attempt.terminal_reason_sha256 IS NOT NULL);

  SELECT pg_catalog.sha256(
    pg_catalog.convert_to('dasher.bundle-membership-retention-snapshot.v1', 'UTF8')
    || pg_catalog.decode('00', 'hex')
    || pg_catalog.convert_to(COALESCE(pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_array(member.run_id, member.bundle_id, member.evidence_id)
      ORDER BY pg_catalog.uuid_send(member.run_id),
        pg_catalog.uuid_send(member.bundle_id), pg_catalog.uuid_send(member.evidence_id)
    )::text, '[]'), 'UTF8')
  ) INTO v_bundle_membership_recheck_sha256
  FROM dasher.candidate_comparison_bundle_evidence AS member
  WHERE member.organization_id = v_organization_id AND member.dashboard_id = $1;
  IF v_bundle_membership_recheck_sha256 <> v_bundle_membership_sha256 THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;
  DELETE FROM dasher.candidate_evidence_manifests
  WHERE organization_id = v_organization_id AND dashboard_id = $1;
  GET DIAGNOSTICS v_phase7_deleted_count = ROW_COUNT;
  IF v_phase7_deleted_count <> (v_phase7_expected_counts ->> 'candidate_evidence_manifests')::bigint THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;
  DELETE FROM dasher.claim_evidence
  WHERE organization_id = v_organization_id AND dashboard_id = $1;
  GET DIAGNOSTICS v_phase7_deleted_count = ROW_COUNT;
  IF v_phase7_deleted_count <> (v_phase7_expected_counts ->> 'claim_evidence')::bigint THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;
  DELETE FROM dasher.claims
  WHERE organization_id = v_organization_id AND dashboard_id = $1;
  GET DIAGNOSTICS v_phase7_deleted_count = ROW_COUNT;
  IF v_phase7_deleted_count <> (v_phase7_expected_counts ->> 'claims')::bigint THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;
  DELETE FROM dasher.agent_validation_findings
  WHERE organization_id = v_organization_id AND dashboard_id = $1;
  GET DIAGNOSTICS v_phase7_deleted_count = ROW_COUNT;
  IF v_phase7_deleted_count <> (v_phase7_expected_counts ->> 'agent_validation_findings')::bigint THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;
  DELETE FROM dasher.agent_candidate_payloads
  WHERE organization_id = v_organization_id AND dashboard_id = $1;
  GET DIAGNOSTICS v_phase7_deleted_count = ROW_COUNT;
  IF v_phase7_deleted_count <> (v_phase7_expected_counts ->> 'agent_candidate_payloads')::bigint THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;
  DELETE FROM dasher.agent_candidates
  WHERE organization_id = v_organization_id AND dashboard_id = $1;
  GET DIAGNOSTICS v_phase7_deleted_count = ROW_COUNT;
  IF v_phase7_deleted_count <> (v_phase7_expected_counts ->> 'agent_candidates')::bigint THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;
  DELETE FROM dasher.agent_run_calculation_meters
  WHERE organization_id = v_organization_id AND dashboard_id = $1;
  GET DIAGNOSTICS v_phase7_deleted_count = ROW_COUNT;
  IF v_phase7_deleted_count <> (v_phase7_expected_counts ->> 'agent_run_calculation_meters')::bigint THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;
  DELETE FROM dasher.calculation_results
  WHERE organization_id = v_organization_id AND dashboard_id = $1;
  GET DIAGNOSTICS v_phase7_deleted_count = ROW_COUNT;
  IF v_phase7_deleted_count <> (v_phase7_expected_counts ->> 'calculation_results')::bigint THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;
  DELETE FROM dasher.calculation_graphs
  WHERE organization_id = v_organization_id AND dashboard_id = $1;
  GET DIAGNOSTICS v_phase7_deleted_count = ROW_COUNT;
  IF v_phase7_deleted_count <> (v_phase7_expected_counts ->> 'calculation_graphs')::bigint THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;
  DELETE FROM dasher.briefs
  WHERE organization_id = v_organization_id AND dashboard_id = $1;
  GET DIAGNOSTICS v_phase7_deleted_count = ROW_COUNT;
  IF v_phase7_deleted_count <> (v_phase7_expected_counts ->> 'briefs')::bigint THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;
  DELETE FROM dasher.run_abstentions
  WHERE organization_id = v_organization_id AND dashboard_id = $1;
  GET DIAGNOSTICS v_phase7_deleted_count = ROW_COUNT;
  IF v_phase7_deleted_count <> (v_phase7_expected_counts ->> 'run_abstentions')::bigint THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;
  DELETE FROM dasher.candidate_comparison_bundle_evidence
  WHERE organization_id = v_organization_id AND dashboard_id = $1;
  GET DIAGNOSTICS v_phase7_deleted_count = ROW_COUNT;
  IF v_phase7_deleted_count <> (v_phase7_expected_counts ->> 'candidate_comparison_bundle_evidence')::bigint THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;
  DELETE FROM dasher.candidate_comparison_bundles
  WHERE organization_id = v_organization_id AND dashboard_id = $1;
  GET DIAGNOSTICS v_phase7_deleted_count = ROW_COUNT;
  IF v_phase7_deleted_count <> (v_phase7_expected_counts ->> 'candidate_comparison_bundles')::bigint THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;
  DELETE FROM dasher.agent_recorded_results
  WHERE organization_id = v_organization_id AND dashboard_id = $1;
  GET DIAGNOSTICS v_phase7_deleted_count = ROW_COUNT;
  IF v_phase7_deleted_count <> (v_phase7_expected_counts ->> 'agent_recorded_results')::bigint THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;
  DELETE FROM dasher.agent_run_request_payloads
  WHERE organization_id = v_organization_id AND dashboard_id = $1;
  GET DIAGNOSTICS v_phase7_deleted_count = ROW_COUNT;
  IF v_phase7_deleted_count <> (v_phase7_expected_counts ->> 'agent_run_request_payloads')::bigint THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;
  DELETE FROM dasher.agent_run_attempt_payloads
  WHERE organization_id = v_organization_id AND dashboard_id = $1;
  GET DIAGNOSTICS v_phase7_deleted_count = ROW_COUNT;
  IF v_phase7_deleted_count <> (v_phase7_expected_counts ->> 'agent_run_attempt_payloads')::bigint THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;
  DELETE FROM dasher.agent_run_checkpoint_payloads
  WHERE organization_id = v_organization_id AND dashboard_id = $1;
  GET DIAGNOSTICS v_phase7_deleted_count = ROW_COUNT;
  IF v_phase7_deleted_count <> (v_phase7_expected_counts ->> 'agent_run_checkpoint_payloads')::bigint THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;
  DELETE FROM dasher.agent_run_event_payloads;
  GET DIAGNOSTICS v_phase7_deleted_count = ROW_COUNT;
  IF v_phase7_deleted_count <> (v_phase7_expected_counts ->> 'agent_run_event_payloads')::bigint THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;
  DELETE FROM dasher.metric_contract_versions
  WHERE organization_id = v_organization_id AND dashboard_id = $1;
  GET DIAGNOSTICS v_phase7_deleted_count = ROW_COUNT;
  IF v_phase7_deleted_count <> (v_phase7_expected_counts ->> 'metric_contract_versions')::bigint THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;
  DELETE FROM dasher.field_catalog_entries
  WHERE organization_id = v_organization_id AND dashboard_id = $1;
  GET DIAGNOSTICS v_phase7_deleted_count = ROW_COUNT;
  IF v_phase7_deleted_count <> (v_phase7_expected_counts ->> 'field_catalog_entries')::bigint THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;
  DELETE FROM dasher.field_catalog_snapshots
  WHERE organization_id = v_organization_id AND dashboard_id = $1;
  GET DIAGNOSTICS v_phase7_deleted_count = ROW_COUNT;
  IF v_phase7_deleted_count <> (v_phase7_expected_counts ->> 'field_catalog_snapshots')::bigint THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;
  IF EXISTS (SELECT 1 FROM dasher.candidate_evidence_manifests WHERE organization_id = v_organization_id AND dashboard_id = $1)
    OR EXISTS (SELECT 1 FROM dasher.claim_evidence WHERE organization_id = v_organization_id AND dashboard_id = $1)
    OR EXISTS (SELECT 1 FROM dasher.claims WHERE organization_id = v_organization_id AND dashboard_id = $1)
    OR EXISTS (SELECT 1 FROM dasher.agent_validation_findings WHERE organization_id = v_organization_id AND dashboard_id = $1)
    OR EXISTS (SELECT 1 FROM dasher.agent_candidate_payloads WHERE organization_id = v_organization_id AND dashboard_id = $1)
    OR EXISTS (SELECT 1 FROM dasher.agent_candidates WHERE organization_id = v_organization_id AND dashboard_id = $1)
    OR EXISTS (SELECT 1 FROM dasher.agent_run_calculation_meters WHERE organization_id = v_organization_id AND dashboard_id = $1)
    OR EXISTS (SELECT 1 FROM dasher.calculation_results WHERE organization_id = v_organization_id AND dashboard_id = $1)
    OR EXISTS (SELECT 1 FROM dasher.calculation_graphs WHERE organization_id = v_organization_id AND dashboard_id = $1)
    OR EXISTS (SELECT 1 FROM dasher.briefs WHERE organization_id = v_organization_id AND dashboard_id = $1)
    OR EXISTS (SELECT 1 FROM dasher.run_abstentions WHERE organization_id = v_organization_id AND dashboard_id = $1)
    OR EXISTS (SELECT 1 FROM dasher.candidate_comparison_bundle_evidence WHERE organization_id = v_organization_id AND dashboard_id = $1)
    OR EXISTS (SELECT 1 FROM dasher.candidate_comparison_bundles WHERE organization_id = v_organization_id AND dashboard_id = $1)
    OR EXISTS (SELECT 1 FROM dasher.agent_recorded_results WHERE organization_id = v_organization_id AND dashboard_id = $1)
    OR EXISTS (SELECT 1 FROM dasher.agent_run_request_payloads WHERE organization_id = v_organization_id AND dashboard_id = $1)
    OR EXISTS (SELECT 1 FROM dasher.agent_run_attempt_payloads WHERE organization_id = v_organization_id AND dashboard_id = $1)
    OR EXISTS (SELECT 1 FROM dasher.agent_run_checkpoint_payloads WHERE organization_id = v_organization_id AND dashboard_id = $1)
    OR EXISTS (SELECT 1 FROM dasher.metric_contract_versions WHERE organization_id = v_organization_id AND dashboard_id = $1)
    OR EXISTS (SELECT 1 FROM dasher.field_catalog_entries WHERE organization_id = v_organization_id AND dashboard_id = $1)
    OR EXISTS (SELECT 1 FROM dasher.field_catalog_snapshots WHERE organization_id = v_organization_id AND dashboard_id = $1)
    OR EXISTS (SELECT 1 FROM dasher.agent_runs AS run
      WHERE run.organization_id = v_organization_id AND run.dashboard_id = $1
        AND (run.request_payload_id IS NOT NULL OR run.candidate_set_sha256 IS NOT NULL
          OR run.terminal_reason_sha256 IS NOT NULL OR run.selected_candidate_id IS NOT NULL
          OR run.consumed_replay_sequence IS NOT NULL OR run.consumed_replay_sha256 IS NOT NULL
          OR run.terminal_claim_input_sha256 IS NOT NULL OR run.terminal_operation_sha256 IS NOT NULL))
    OR EXISTS (SELECT 1 FROM dasher.agent_run_events AS event
      WHERE event.organization_id = v_organization_id AND event.dashboard_id = $1
        AND (event.event_payload_id IS NOT NULL OR event.claim_input_sha256 IS NOT NULL
          OR event.claim_result_sha256 IS NOT NULL OR event.claim_result_attempt_token IS NOT NULL
          OR event.claim_result_input_sha256 IS NOT NULL))
    OR EXISTS (SELECT 1 FROM dasher.agent_run_checkpoints AS checkpoint
      WHERE checkpoint.organization_id = v_organization_id AND checkpoint.dashboard_id = $1
        AND (checkpoint.state_sha256 IS NOT NULL OR checkpoint.checkpoint_payload_id IS NOT NULL))
    OR EXISTS (SELECT 1 FROM dasher.agent_run_attempts AS attempt
      WHERE attempt.organization_id = v_organization_id AND attempt.dashboard_id = $1
        AND (attempt.request_payload_id IS NOT NULL OR attempt.result_payload_id IS NOT NULL
          OR attempt.terminal_reason_sha256 IS NOT NULL))
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;

  WITH candidates AS MATERIALIZED (
    SELECT claim.organization_id, claim.snapshot_id, claim.reference_claim_id
    FROM dasher.snapshot_reference_claims AS claim
    WHERE claim.organization_id = v_organization_id AND claim.dashboard_id = $1
      AND claim.claim_kind = 'access_bearing' AND claim.hold_id IS NULL
    ORDER BY claim.snapshot_id, claim.reference_claim_id
    LIMIT v_batch_limit
    FOR UPDATE OF claim
  )
  DELETE FROM dasher.snapshot_reference_claims AS claim
  USING candidates AS candidate
  WHERE claim.organization_id = candidate.organization_id
    AND claim.snapshot_id = candidate.snapshot_id
    AND claim.reference_claim_id = candidate.reference_claim_id;
  GET DIAGNOSTICS v_row_count = ROW_COUNT;
  IF v_row_count > 0 THEN RETURN; END IF;

  WITH candidates AS MATERIALIZED (
    SELECT claim.organization_id, claim.evidence_id, claim.reference_claim_id
    FROM dasher.evidence_reference_claims AS claim
    WHERE claim.organization_id = v_organization_id AND claim.dashboard_id = $1
      AND claim.claim_kind = 'access_bearing' AND claim.hold_id IS NULL
    ORDER BY claim.evidence_id, claim.reference_claim_id
    LIMIT v_batch_limit
    FOR UPDATE OF claim
  )
  DELETE FROM dasher.evidence_reference_claims AS claim
  USING candidates AS candidate
  WHERE claim.organization_id = candidate.organization_id
    AND claim.evidence_id = candidate.evidence_id
    AND claim.reference_claim_id = candidate.reference_claim_id;
  GET DIAGNOSTICS v_row_count = ROW_COUNT;
  IF v_row_count > 0 THEN RETURN; END IF;

  WITH candidates AS MATERIALIZED (
    SELECT claim.organization_id, claim.artifact_id, claim.reference_claim_id
    FROM dasher.artifact_reference_claims AS claim
    WHERE claim.organization_id = v_organization_id AND claim.dashboard_id = $1
      AND claim.claim_kind = 'access_bearing' AND claim.hold_id IS NULL
    ORDER BY claim.artifact_id, claim.reference_claim_id
    LIMIT v_batch_limit
    FOR UPDATE OF claim
  )
  DELETE FROM dasher.artifact_reference_claims AS claim
  USING candidates AS candidate
  WHERE claim.organization_id = candidate.organization_id
    AND claim.artifact_id = candidate.artifact_id
    AND claim.reference_claim_id = candidate.reference_claim_id;
  GET DIAGNOSTICS v_row_count = ROW_COUNT;
  IF v_row_count > 0 THEN RETURN; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM dasher.dashboard_cleanup_attempts AS attempt
    WHERE attempt.organization_id = v_organization_id
      AND attempt.dashboard_id = $1 AND attempt.step = 'purge_finalizing'
      AND attempt.result = 'succeeded' AND attempt.proof_sha256 = $3
  ) THEN
    INSERT INTO dasher.dashboard_cleanup_attempts (
      organization_id, dashboard_id, cleanup_attempt_id, step, started_at,
      finished_at, result, released_claim_count, deleted_resource_count,
      deferred_claim_count, failure_code, proof_sha256
    ) VALUES (v_organization_id, $1, $4, 'purge_finalizing', v_now, v_now,
      'succeeded', 0, 0, 0, NULL, $3);
    RETURN;
  END IF;

  WITH candidates AS MATERIALIZED (
    SELECT finalizer.organization_id, finalizer.snapshot_id
    FROM dasher.snapshot_deletion_finalizers AS finalizer
    WHERE finalizer.organization_id = v_organization_id
      AND finalizer.state = 'intent'
      AND finalizer.expected_claim_set_sha256 = sha256(
        uuid_send(v_organization_id) || uuid_send($1)
        || uuid_send(finalizer.snapshot_id) || convert_to('snapshot|expected_claim_set=empty', 'UTF8')
      )
      AND NOT EXISTS (
        SELECT 1 FROM dasher.snapshot_reference_claims AS claim
        WHERE claim.organization_id = finalizer.organization_id
          AND claim.snapshot_id = finalizer.snapshot_id
      )
    ORDER BY finalizer.snapshot_id
    LIMIT v_batch_limit
    FOR UPDATE OF finalizer
  )
  UPDATE dasher.snapshot_deletion_finalizers AS finalizer
  SET state = 'eligible', proof_sha256 = finalizer.expected_claim_set_sha256
  FROM candidates AS candidate
  WHERE finalizer.organization_id = candidate.organization_id
    AND finalizer.snapshot_id = candidate.snapshot_id;
  GET DIAGNOSTICS v_row_count = ROW_COUNT;
  IF v_row_count > 0 THEN RETURN; END IF;

  WITH candidates AS MATERIALIZED (
    SELECT finalizer.organization_id, finalizer.evidence_id
    FROM dasher.evidence_deletion_finalizers AS finalizer
    WHERE finalizer.organization_id = v_organization_id
      AND finalizer.state = 'intent'
      AND finalizer.expected_claim_set_sha256 = sha256(
        uuid_send(v_organization_id) || uuid_send($1)
        || uuid_send(finalizer.evidence_id) || convert_to('evidence|expected_claim_set=empty', 'UTF8')
      )
      AND NOT EXISTS (
        SELECT 1 FROM dasher.evidence_reference_claims AS claim
        WHERE claim.organization_id = finalizer.organization_id
          AND claim.evidence_id = finalizer.evidence_id
      )
    ORDER BY finalizer.evidence_id
    LIMIT v_batch_limit
    FOR UPDATE OF finalizer
  )
  UPDATE dasher.evidence_deletion_finalizers AS finalizer
  SET state = 'eligible', proof_sha256 = finalizer.expected_claim_set_sha256
  FROM candidates AS candidate
  WHERE finalizer.organization_id = candidate.organization_id
    AND finalizer.evidence_id = candidate.evidence_id;
  GET DIAGNOSTICS v_row_count = ROW_COUNT;
  IF v_row_count > 0 THEN RETURN; END IF;

  WITH candidates AS MATERIALIZED (
    SELECT finalizer.organization_id, finalizer.artifact_id
    FROM dasher.artifact_deletion_finalizers AS finalizer
    WHERE finalizer.organization_id = v_organization_id
      AND finalizer.state = 'intent'
      AND finalizer.expected_claim_set_sha256 = sha256(
        uuid_send(v_organization_id) || uuid_send($1)
        || uuid_send(finalizer.artifact_id) || convert_to('artifact|expected_claim_set=empty', 'UTF8')
      )
      AND NOT EXISTS (
        SELECT 1 FROM dasher.artifact_reference_claims AS claim
        WHERE claim.organization_id = finalizer.organization_id
          AND claim.artifact_id = finalizer.artifact_id
      )
    ORDER BY finalizer.artifact_id
    LIMIT v_batch_limit
    FOR UPDATE OF finalizer
  )
  UPDATE dasher.artifact_deletion_finalizers AS finalizer
  SET state = 'eligible', proof_sha256 = finalizer.expected_claim_set_sha256
  FROM candidates AS candidate
  WHERE finalizer.organization_id = candidate.organization_id
    AND finalizer.artifact_id = candidate.artifact_id;
  GET DIAGNOSTICS v_row_count = ROW_COUNT;
  IF v_row_count > 0 THEN RETURN; END IF;

  IF EXISTS (
    SELECT 1 FROM dasher.snapshot_deletion_finalizers AS finalizer
    WHERE finalizer.organization_id = v_organization_id
      AND finalizer.state = 'intent'
      AND finalizer.expected_claim_set_sha256 = sha256(
        uuid_send(v_organization_id) || uuid_send($1)
        || uuid_send(finalizer.snapshot_id) || convert_to('snapshot|expected_claim_set=empty', 'UTF8')
      )
  ) OR EXISTS (
    SELECT 1 FROM dasher.evidence_deletion_finalizers AS finalizer
    WHERE finalizer.organization_id = v_organization_id
      AND finalizer.state = 'intent'
      AND finalizer.expected_claim_set_sha256 = sha256(
        uuid_send(v_organization_id) || uuid_send($1)
        || uuid_send(finalizer.evidence_id) || convert_to('evidence|expected_claim_set=empty', 'UTF8')
      )
  ) OR EXISTS (
    SELECT 1 FROM dasher.artifact_deletion_finalizers AS finalizer
    WHERE finalizer.organization_id = v_organization_id
      AND finalizer.state = 'intent'
      AND finalizer.expected_claim_set_sha256 = sha256(
        uuid_send(v_organization_id) || uuid_send($1)
        || uuid_send(finalizer.artifact_id) || convert_to('artifact|expected_claim_set=empty', 'UTF8')
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM dasher.dashboard_cleanup_attempts AS attempt
    WHERE attempt.organization_id = v_organization_id
      AND attempt.dashboard_id = $1 AND attempt.step = 'prepare_finalizers'
      AND attempt.result = 'succeeded' AND attempt.proof_sha256 = $3
  ) THEN
    INSERT INTO dasher.dashboard_cleanup_attempts (
      organization_id, dashboard_id, cleanup_attempt_id, step, started_at,
      finished_at, result, released_claim_count, deleted_resource_count,
      deferred_claim_count, failure_code, proof_sha256
    ) VALUES (v_organization_id, $1, $4, 'prepare_finalizers', v_now, v_now,
      'succeeded', 0, 0, 0, NULL, $3);
    RETURN;
  END IF;

  WITH candidates AS MATERIALIZED (
    SELECT lineage.organization_id, lineage.dashboard_id, lineage.version_id
    FROM dasher.dashboard_restore_lineage AS lineage
    WHERE lineage.organization_id = v_organization_id
      AND lineage.dashboard_id = $1
    ORDER BY lineage.version_id
    LIMIT v_batch_limit
    FOR UPDATE OF lineage
  )
  DELETE FROM dasher.dashboard_restore_lineage AS lineage
  USING candidates AS candidate
  WHERE lineage.organization_id = candidate.organization_id
    AND lineage.dashboard_id = candidate.dashboard_id
    AND lineage.version_id = candidate.version_id;
  GET DIAGNOSTICS v_row_count = ROW_COUNT;
  IF v_row_count > 0 THEN RETURN; END IF;

  WITH candidates AS MATERIALIZED (
    SELECT link.organization_id, link.dashboard_id, link.version_id,
      link.evidence_id
    FROM dasher.dashboard_version_evidence AS link
    WHERE link.organization_id = v_organization_id AND link.dashboard_id = $1
    ORDER BY link.version_id, link.evidence_id
    LIMIT v_batch_limit
    FOR UPDATE OF link
  )
  DELETE FROM dasher.dashboard_version_evidence AS link
  USING candidates AS candidate
  WHERE link.organization_id = candidate.organization_id
    AND link.dashboard_id = candidate.dashboard_id
    AND link.version_id = candidate.version_id
    AND link.evidence_id = candidate.evidence_id;
  GET DIAGNOSTICS v_row_count = ROW_COUNT;
  IF v_row_count > 0 THEN RETURN; END IF;

  WITH candidates AS MATERIALIZED (
    SELECT link.organization_id, link.dashboard_id, link.version_id,
      link.snapshot_id
    FROM dasher.dashboard_version_snapshots AS link
    WHERE link.organization_id = v_organization_id AND link.dashboard_id = $1
    ORDER BY link.version_id, link.snapshot_id
    LIMIT v_batch_limit
    FOR UPDATE OF link
  )
  DELETE FROM dasher.dashboard_version_snapshots AS link
  USING candidates AS candidate
  WHERE link.organization_id = candidate.organization_id
    AND link.dashboard_id = candidate.dashboard_id
    AND link.version_id = candidate.version_id
    AND link.snapshot_id = candidate.snapshot_id;
  GET DIAGNOSTICS v_row_count = ROW_COUNT;
  IF v_row_count > 0 THEN RETURN; END IF;

  WITH candidates AS MATERIALIZED (
    SELECT finalizer.organization_id, finalizer.artifact_id
    FROM dasher.artifact_deletion_finalizers AS finalizer
    WHERE finalizer.organization_id = v_organization_id
      AND finalizer.state = 'eligible'
      AND finalizer.expected_claim_set_sha256 = sha256(
        uuid_send(v_organization_id) || uuid_send($1)
        || uuid_send(finalizer.artifact_id) || convert_to('artifact|expected_claim_set=empty', 'UTF8')
      )
      AND NOT EXISTS (
        SELECT 1 FROM dasher.artifact_reference_claims AS claim
        WHERE claim.organization_id = finalizer.organization_id
          AND claim.artifact_id = finalizer.artifact_id
      )
    ORDER BY finalizer.artifact_id
    LIMIT v_batch_limit
    FOR UPDATE OF finalizer
  )
  UPDATE dasher.artifact_deletion_finalizers AS finalizer
  SET state = 'deleted', bytes_deleted_at = v_now
  FROM candidates AS candidate
  WHERE finalizer.organization_id = candidate.organization_id
    AND finalizer.artifact_id = candidate.artifact_id;
  GET DIAGNOSTICS v_row_count = ROW_COUNT;
  IF v_row_count > 0 THEN
    SELECT count(*) INTO v_expected_delete_count
    FROM dasher.dashboard_artifacts AS artifact
    WHERE artifact.organization_id = v_organization_id
      AND EXISTS (
        SELECT 1 FROM dasher.artifact_deletion_finalizers AS finalizer
        WHERE finalizer.organization_id = artifact.organization_id
          AND finalizer.artifact_id = artifact.artifact_id
          AND finalizer.state = 'deleted'
          AND finalizer.bytes_deleted_at = v_now
          AND finalizer.expected_claim_set_sha256 = sha256(
            uuid_send(v_organization_id) || uuid_send($1)
            || uuid_send(finalizer.artifact_id)
            || convert_to('artifact|expected_claim_set=empty', 'UTF8')
          )
      );
    DELETE FROM dasher.dashboard_artifacts AS artifact
    WHERE artifact.organization_id = v_organization_id
      AND EXISTS (
        SELECT 1 FROM dasher.artifact_deletion_finalizers AS finalizer
        WHERE finalizer.organization_id = artifact.organization_id
          AND finalizer.artifact_id = artifact.artifact_id
          AND finalizer.state = 'deleted'
          AND finalizer.bytes_deleted_at = v_now
          AND finalizer.expected_claim_set_sha256 = sha256(
            uuid_send(v_organization_id) || uuid_send($1)
            || uuid_send(finalizer.artifact_id)
            || convert_to('artifact|expected_claim_set=empty', 'UTF8')
          )
      );
    GET DIAGNOSTICS v_deleted_row_count = ROW_COUNT;
    IF v_deleted_row_count <> v_expected_delete_count OR EXISTS (
      SELECT 1 FROM dasher.dashboard_artifacts AS artifact
      JOIN dasher.artifact_deletion_finalizers AS finalizer
        ON finalizer.organization_id = artifact.organization_id
       AND finalizer.artifact_id = artifact.artifact_id
      WHERE finalizer.organization_id = v_organization_id
        AND finalizer.state = 'deleted'
        AND finalizer.bytes_deleted_at = v_now
        AND finalizer.expected_claim_set_sha256 = sha256(
          uuid_send(v_organization_id) || uuid_send($1)
          || uuid_send(finalizer.artifact_id)
          || convert_to('artifact|expected_claim_set=empty', 'UTF8')
        )
    ) THEN
      RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
    END IF;
    RETURN;
  END IF;

  WITH candidates AS MATERIALIZED (
    SELECT version.organization_id, version.dashboard_id, version.version_id
    FROM dasher.dashboard_versions AS version
    WHERE version.organization_id = v_organization_id
      AND version.dashboard_id = $1
      AND NOT EXISTS (
        SELECT 1 FROM dasher.dashboard_versions AS child
        WHERE child.organization_id = version.organization_id
          AND child.dashboard_id = version.dashboard_id
          AND child.parent_version_id = version.version_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM dasher.dashboard_artifacts AS artifact
        WHERE artifact.organization_id = version.organization_id
          AND artifact.dashboard_id = version.dashboard_id
          AND artifact.version_id = version.version_id
          AND artifact.ownership_class = 'dashboard_owned'
      )
    ORDER BY version.version_id
    LIMIT v_batch_limit
    FOR UPDATE OF version
  )
  DELETE FROM dasher.dashboard_versions AS version
  USING candidates AS candidate
  WHERE version.organization_id = candidate.organization_id
    AND version.dashboard_id = candidate.dashboard_id
    AND version.version_id = candidate.version_id;
  GET DIAGNOSTICS v_row_count = ROW_COUNT;
  IF v_row_count > 0 THEN RETURN; END IF;

  WITH candidates AS MATERIALIZED (
    SELECT finalizer.organization_id, finalizer.evidence_id
    FROM dasher.evidence_deletion_finalizers AS finalizer
    WHERE finalizer.organization_id = v_organization_id
      AND finalizer.state = 'eligible'
      AND finalizer.expected_claim_set_sha256 = sha256(
        uuid_send(v_organization_id) || uuid_send($1)
        || uuid_send(finalizer.evidence_id) || convert_to('evidence|expected_claim_set=empty', 'UTF8')
      )
      AND NOT EXISTS (
        SELECT 1 FROM dasher.evidence_reference_claims AS claim
        WHERE claim.organization_id = finalizer.organization_id
          AND claim.evidence_id = finalizer.evidence_id
      )
    ORDER BY finalizer.evidence_id
    LIMIT v_batch_limit
    FOR UPDATE OF finalizer
  )
  UPDATE dasher.evidence_deletion_finalizers AS finalizer
  SET state = 'deleted', bytes_deleted_at = v_now
  FROM candidates AS candidate
  WHERE finalizer.organization_id = candidate.organization_id
    AND finalizer.evidence_id = candidate.evidence_id;
  GET DIAGNOSTICS v_row_count = ROW_COUNT;
  IF v_row_count > 0 THEN
    SELECT count(*) INTO v_expected_delete_count
    FROM dasher.evidence_records AS evidence
    WHERE evidence.organization_id = v_organization_id
      AND EXISTS (
        SELECT 1 FROM dasher.evidence_deletion_finalizers AS finalizer
        WHERE finalizer.organization_id = evidence.organization_id
          AND finalizer.evidence_id = evidence.evidence_id
          AND finalizer.state = 'deleted'
          AND finalizer.bytes_deleted_at = v_now
          AND finalizer.expected_claim_set_sha256 = sha256(
            uuid_send(v_organization_id) || uuid_send($1)
            || uuid_send(finalizer.evidence_id)
            || convert_to('evidence|expected_claim_set=empty', 'UTF8')
          )
      );
    DELETE FROM dasher.evidence_records AS evidence
    WHERE evidence.organization_id = v_organization_id
      AND EXISTS (
        SELECT 1 FROM dasher.evidence_deletion_finalizers AS finalizer
        WHERE finalizer.organization_id = evidence.organization_id
          AND finalizer.evidence_id = evidence.evidence_id
          AND finalizer.state = 'deleted'
          AND finalizer.bytes_deleted_at = v_now
          AND finalizer.expected_claim_set_sha256 = sha256(
            uuid_send(v_organization_id) || uuid_send($1)
            || uuid_send(finalizer.evidence_id)
            || convert_to('evidence|expected_claim_set=empty', 'UTF8')
          )
      );
    GET DIAGNOSTICS v_deleted_row_count = ROW_COUNT;
    IF v_deleted_row_count <> v_expected_delete_count OR EXISTS (
      SELECT 1 FROM dasher.evidence_records AS evidence
      JOIN dasher.evidence_deletion_finalizers AS finalizer
        ON finalizer.organization_id = evidence.organization_id
       AND finalizer.evidence_id = evidence.evidence_id
      WHERE finalizer.organization_id = v_organization_id
        AND finalizer.state = 'deleted'
        AND finalizer.bytes_deleted_at = v_now
        AND finalizer.expected_claim_set_sha256 = sha256(
          uuid_send(v_organization_id) || uuid_send($1)
          || uuid_send(finalizer.evidence_id)
          || convert_to('evidence|expected_claim_set=empty', 'UTF8')
        )
    ) THEN
      RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
    END IF;
    RETURN;
  END IF;

  WITH candidates AS MATERIALIZED (
    SELECT finalizer.organization_id, finalizer.snapshot_id
    FROM dasher.snapshot_deletion_finalizers AS finalizer
    WHERE finalizer.organization_id = v_organization_id
      AND finalizer.state = 'eligible'
      AND finalizer.expected_claim_set_sha256 = sha256(
        uuid_send(v_organization_id) || uuid_send($1)
        || uuid_send(finalizer.snapshot_id) || convert_to('snapshot|expected_claim_set=empty', 'UTF8')
      )
      AND NOT EXISTS (
        SELECT 1 FROM dasher.snapshot_reference_claims AS claim
        WHERE claim.organization_id = finalizer.organization_id
          AND claim.snapshot_id = finalizer.snapshot_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM dasher.evidence_records AS evidence
        WHERE evidence.organization_id = finalizer.organization_id
          AND evidence.snapshot_id = finalizer.snapshot_id
      )
    ORDER BY finalizer.snapshot_id
    LIMIT v_batch_limit
    FOR UPDATE OF finalizer
  )
  UPDATE dasher.snapshot_deletion_finalizers AS finalizer
  SET state = 'deleted', bytes_deleted_at = v_now
  FROM candidates AS candidate
  WHERE finalizer.organization_id = candidate.organization_id
    AND finalizer.snapshot_id = candidate.snapshot_id;
  GET DIAGNOSTICS v_row_count = ROW_COUNT;
  IF v_row_count > 0 THEN
    SELECT count(*) INTO v_expected_delete_count
    FROM dasher.source_snapshots AS snapshot
    WHERE snapshot.organization_id = v_organization_id
      AND EXISTS (
        SELECT 1 FROM dasher.snapshot_deletion_finalizers AS finalizer
        WHERE finalizer.organization_id = snapshot.organization_id
          AND finalizer.snapshot_id = snapshot.snapshot_id
          AND finalizer.state = 'deleted'
          AND finalizer.bytes_deleted_at = v_now
          AND finalizer.expected_claim_set_sha256 = sha256(
            uuid_send(v_organization_id) || uuid_send($1)
            || uuid_send(finalizer.snapshot_id)
            || convert_to('snapshot|expected_claim_set=empty', 'UTF8')
          )
      );
    DELETE FROM dasher.source_snapshots AS snapshot
    WHERE snapshot.organization_id = v_organization_id
      AND EXISTS (
        SELECT 1 FROM dasher.snapshot_deletion_finalizers AS finalizer
        WHERE finalizer.organization_id = snapshot.organization_id
          AND finalizer.snapshot_id = snapshot.snapshot_id
          AND finalizer.state = 'deleted'
          AND finalizer.bytes_deleted_at = v_now
          AND finalizer.expected_claim_set_sha256 = sha256(
            uuid_send(v_organization_id) || uuid_send($1)
            || uuid_send(finalizer.snapshot_id)
            || convert_to('snapshot|expected_claim_set=empty', 'UTF8')
          )
      );
    GET DIAGNOSTICS v_deleted_row_count = ROW_COUNT;
    IF v_deleted_row_count <> v_expected_delete_count OR EXISTS (
      SELECT 1 FROM dasher.source_snapshots AS snapshot
      JOIN dasher.snapshot_deletion_finalizers AS finalizer
        ON finalizer.organization_id = snapshot.organization_id
       AND finalizer.snapshot_id = snapshot.snapshot_id
      WHERE finalizer.organization_id = v_organization_id
        AND finalizer.state = 'deleted'
        AND finalizer.bytes_deleted_at = v_now
        AND finalizer.expected_claim_set_sha256 = sha256(
          uuid_send(v_organization_id) || uuid_send($1)
          || uuid_send(finalizer.snapshot_id)
          || convert_to('snapshot|expected_claim_set=empty', 'UTF8')
        )
    ) THEN
      RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
    END IF;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM dasher.dashboard_versions AS version
    WHERE version.organization_id = v_organization_id AND version.dashboard_id = $1
  ) OR EXISTS (
    SELECT 1 FROM dasher.dashboard_artifacts AS artifact
    WHERE artifact.organization_id = v_organization_id
      AND (
        (artifact.ownership_class = 'dashboard_owned'
          AND artifact.dashboard_id = $1)
        OR
        (artifact.ownership_class = 'shared' AND EXISTS (
          SELECT 1 FROM dasher.artifact_reference_claims AS target_claim
          WHERE target_claim.organization_id = artifact.organization_id
            AND target_claim.artifact_id = artifact.artifact_id
            AND target_claim.dashboard_id = $1
            AND target_claim.claim_kind = 'access_bearing'
            AND target_claim.hold_id IS NULL
        ))
      )
  ) OR EXISTS (
    SELECT 1 FROM dasher.snapshot_deletion_finalizers AS finalizer
    JOIN dasher.source_snapshots AS snapshot
      ON snapshot.organization_id = finalizer.organization_id
     AND snapshot.snapshot_id = finalizer.snapshot_id
    WHERE finalizer.organization_id = v_organization_id
      AND finalizer.expected_claim_set_sha256 = sha256(
        uuid_send(v_organization_id) || uuid_send($1)
        || uuid_send(finalizer.snapshot_id) || convert_to('snapshot|expected_claim_set=empty', 'UTF8')
      )
  ) OR EXISTS (
    SELECT 1 FROM dasher.evidence_deletion_finalizers AS finalizer
    JOIN dasher.evidence_records AS evidence
      ON evidence.organization_id = finalizer.organization_id
     AND evidence.evidence_id = finalizer.evidence_id
    WHERE finalizer.organization_id = v_organization_id
      AND finalizer.expected_claim_set_sha256 = sha256(
        uuid_send(v_organization_id) || uuid_send($1)
        || uuid_send(finalizer.evidence_id) || convert_to('evidence|expected_claim_set=empty', 'UTF8')
      )
  ) OR EXISTS (
    SELECT 1 FROM dasher.artifact_deletion_finalizers AS finalizer
    JOIN dasher.dashboard_artifacts AS artifact
      ON artifact.organization_id = finalizer.organization_id
     AND artifact.artifact_id = finalizer.artifact_id
    WHERE finalizer.organization_id = v_organization_id
      AND finalizer.expected_claim_set_sha256 = sha256(
        uuid_send(v_organization_id) || uuid_send($1)
        || uuid_send(finalizer.artifact_id) || convert_to('artifact|expected_claim_set=empty', 'UTF8')
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;

  IF v_coordination.current_step <> 'final_proof_ready' THEN
    INSERT INTO dasher.dashboard_cleanup_attempts (
      organization_id, dashboard_id, cleanup_attempt_id, step, started_at,
      finished_at, result, released_claim_count, deleted_resource_count,
      deferred_claim_count, failure_code, proof_sha256
    ) VALUES (v_organization_id, $1, $4, 'finalize_resources', v_now, v_now,
      'succeeded', 0, 0, 0, NULL, $3);
    UPDATE dasher.dashboard_cleanup_coordination
    SET current_step = 'final_proof_ready', lease_owner = NULL,
      lease_expires_at = NULL, expected_lifecycle_revision = $2,
      next_attempt_at = v_now, completion_proof_sha256 = $3
    WHERE organization_id = v_organization_id AND dashboard_id = $1
      AND expected_lifecycle_revision = $2
      AND completion_proof_sha256 = $3;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
    END IF;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM dasher.dashboard_restore_lineage AS lineage
    WHERE lineage.organization_id = v_organization_id AND lineage.dashboard_id = $1
  ) OR EXISTS (
    SELECT 1 FROM dasher.dashboard_version_snapshots AS link
    WHERE link.organization_id = v_organization_id AND link.dashboard_id = $1
  ) OR EXISTS (
    SELECT 1 FROM dasher.dashboard_version_evidence AS link
    WHERE link.organization_id = v_organization_id AND link.dashboard_id = $1
  ) OR EXISTS (
    SELECT 1 FROM dasher.snapshot_reference_claims AS claim
    WHERE claim.organization_id = v_organization_id AND claim.dashboard_id = $1
  ) OR EXISTS (
    SELECT 1 FROM dasher.evidence_reference_claims AS claim
    WHERE claim.organization_id = v_organization_id AND claim.dashboard_id = $1
  ) OR EXISTS (
    SELECT 1 FROM dasher.artifact_reference_claims AS claim
    WHERE claim.organization_id = v_organization_id AND claim.dashboard_id = $1
  ) OR EXISTS (
    SELECT 1 FROM dasher.snapshot_deletion_finalizers AS finalizer
    WHERE finalizer.organization_id = v_organization_id
      AND finalizer.state <> 'deleted'
      AND finalizer.expected_claim_set_sha256 = sha256(
        uuid_send(v_organization_id) || uuid_send($1)
        || uuid_send(finalizer.snapshot_id) || convert_to('snapshot|expected_claim_set=empty', 'UTF8')
      )
  ) OR EXISTS (
    SELECT 1 FROM dasher.evidence_deletion_finalizers AS finalizer
    WHERE finalizer.organization_id = v_organization_id
      AND finalizer.state <> 'deleted'
      AND finalizer.expected_claim_set_sha256 = sha256(
        uuid_send(v_organization_id) || uuid_send($1)
        || uuid_send(finalizer.evidence_id) || convert_to('evidence|expected_claim_set=empty', 'UTF8')
      )
  ) OR EXISTS (
    SELECT 1 FROM dasher.artifact_deletion_finalizers AS finalizer
    WHERE finalizer.organization_id = v_organization_id
      AND finalizer.state <> 'deleted'
      AND finalizer.expected_claim_set_sha256 = sha256(
        uuid_send(v_organization_id) || uuid_send($1)
        || uuid_send(finalizer.artifact_id) || convert_to('artifact|expected_claim_set=empty', 'UTF8')
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;

  IF NOT dasher_private.verify_phase7_content_purge_fk_dag_v1(
    v_organization_id, $1
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;

  UPDATE dasher.dashboard_tombstones SET purged_at = v_now,
    purged_lifecycle_revision = $2 + 1, purged_proof_sha256 = $3
  WHERE organization_id = v_organization_id
    AND tombstone_lineage_id = v_dashboard.tombstone_lineage_id
    AND purged_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;
  SELECT COALESCE(max(ledger_sequence), 0) + 1 INTO v_ledger_sequence
  FROM dasher.backup_deletion_ledger WHERE organization_id = v_organization_id;
  INSERT INTO dasher.backup_deletion_ledger (
    organization_id, ledger_sequence, tombstone_lineage_id, lifecycle_revision,
    event_kind, event_occurred_at, inserted_at, retention_policy_revision,
    proof_sha256
  ) VALUES (v_organization_id, v_ledger_sequence,
    v_dashboard.tombstone_lineage_id, $2 + 1, 'purged', v_now, v_now,
    v_dashboard.retention_policy_revision, $3);
  INSERT INTO dasher.dashboard_cleanup_attempts (
    organization_id, dashboard_id, cleanup_attempt_id, step, started_at,
    finished_at, result, released_claim_count, deleted_resource_count,
    deferred_claim_count, failure_code, proof_sha256
  ) VALUES (v_organization_id, $1, $4, 'purged', v_now, v_now,
    'already_complete', 0, 0, 0, NULL, $3);
  UPDATE dasher.dashboard_cleanup_coordination
  SET current_step = 'cleaned', lease_owner = NULL, lease_expires_at = NULL,
    expected_lifecycle_revision = $2 + 1, next_attempt_at = NULL,
    completion_proof_sha256 = $3
  WHERE organization_id = v_organization_id AND dashboard_id = $1
    AND current_step = 'final_proof_ready'
    AND expected_lifecycle_revision = $2
    AND completion_proof_sha256 = $3;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;
  UPDATE dasher.dashboards SET lifecycle_state = 'cleaned', purged_at = v_now,
    lifecycle_revision = lifecycle_revision + 1
  WHERE organization_id = v_organization_id AND dashboard_id = $1
    AND lifecycle_revision = $2 AND lifecycle_state = 'purge_eligible'
    AND purge_started_at IS NOT NULL AND purged_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;
  INSERT INTO dasher.dashboard_lifecycle_events (
    lifecycle_event_id, organization_id, dashboard_id, lifecycle_revision,
    event_kind, from_kind, to_kind, from_state, to_state, occurred_at,
    actor_user_id, actor_service, authority_revision, retention_policy_revision,
    request_id, job_id, reason_sha256
  ) VALUES (
    $4, v_organization_id, $1, $2 + 1, 'purged',
    v_dashboard.current_kind, v_dashboard.current_kind, 'purge_eligible',
    'cleaned', v_now, NULL, session_user::text, v_authority_revision,
    v_dashboard.retention_policy_revision,
    current_setting('dasher.retention_request_id', true)::uuid, NULL, $3
  );
  BEGIN
    INSERT INTO dasher.audit_events (
      audit_event_id, organization_id, occurred_at, actor_kind, actor_user_id,
      actor_service, authority_revision, request_id, job_id, action, target_type,
      target_id, outcome, content_sha256, source_ref, provider,
      credential_version, usage_units, cost_minor_units, deployment_revision
    ) VALUES (
      $4, v_organization_id, v_now, 'service', NULL, session_user::text,
      v_authority_revision, current_setting('dasher.retention_request_id', true)::uuid,
      NULL, 'dashboard.purged', 'dashboard', $1, 'succeeded', $3,
      NULL, NULL, NULL, NULL, NULL, $5
    );
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END;
END
$function$;

-- Part 9 - dasher.backup_deletion_ledger event-kind vocabulary correction.
--
-- dasher_retention_api.age_out_dashboard_agent_run_metadata is a frozen public
-- entry point, and its precondition is a dasher.backup_deletion_ledger row for
-- the dashboard's tombstone lineage whose event_kind is 'backup.deleted'
-- (0007:23975). It reads that row with SELECT ... INTO STRICT, so when no such
-- row exists the call dies at the lookup with an unnormalized P0002.
--
-- No such row can exist. The frozen 0003 CHECK constraint
-- backup_deletion_ledger_event_kind_check (0003:453) admits exactly
-- 'access_revoked' and 'purged', so every INSERT of 'backup.deleted' is
-- refused with 23514 no matter who issues it - the retention definer under its
-- own INSERT policy, the security definer, or the migration owner. The frozen
-- entry point is therefore not merely hard to reach: it is unreachable, and
-- the age-out the plan delivers as real behaviour (delete at purged_at plus
-- 365 days, through the fixed retention API) cannot execute at all.
--
-- This corrects the constraint in place. The name is unchanged, the relation
-- is unchanged, the column is unchanged, and the shape is unchanged: it is
-- still a single CHECK over event_kind against a closed list. The only
-- difference is that the list gains exactly one value - 'backup.deleted' - the
-- one the frozen age-out already requires. The constraint still enforces the
-- vocabulary: every other value is still refused with 23514, so the ledger
-- cannot record an event kind no part of this series names. No row is read,
-- written, moved or deleted; ADD CONSTRAINT revalidates the rows already there
-- and every one of them carries 'access_revoked' or 'purged', which both
-- remain admissible.
--
-- Widening a CHECK is not a weakening of any security semantic. The constraint
-- is a data-vocabulary gate, not an authority gate: who may write this table is
-- decided by the two frozen 0003 policies
-- (backup_deletion_ledger_retention_select and
-- backup_deletion_ledger_retention_insert) and the grants beside them, none of
-- which this part touches. A caller that could not insert a ledger row before
-- still cannot insert one; a caller that could may now spell one more event
-- kind, and only the one the frozen reader demands.
--
-- pg_get_constraintdef is part of the inventory the phase fingerprints hash,
-- so this part moves the phase-8 fingerprint. It does not move the entry
-- count: the constraint keeps its name and its relation, so its inventory
-- identity is unchanged and only its definition moves.

ALTER TABLE dasher.backup_deletion_ledger
  DROP CONSTRAINT backup_deletion_ledger_event_kind_check;
ALTER TABLE dasher.backup_deletion_ledger
  ADD CONSTRAINT backup_deletion_ledger_event_kind_check
  CHECK ((event_kind = ANY (ARRAY['access_revoked'::text, 'purged'::text, 'backup.deleted'::text])));

-- Part 10 - dasher_api.cancel_agent_run audit-event-id collision
-- normalization.
--
-- This is the sixth and last frozen 0007 entry point that writes the global
-- dasher.audit_events primary key from a caller-supplied uuid, and it is the
-- one this correction previously left unwrapped. The argument for that
-- exemption was that the frozen body carries a global uniqueness probe over
-- dasher.audit_events keyed on the operation id alone (0007:19860), taken after
-- pg_advisory_xact_lock on a key derived from that same id (0007:19838), so the
-- probe and the INSERT are serialized against every other transaction that
-- could spend the id and a duplicate is refused - as P1001 / dasher_denied,
-- the code that probe raises (0007:19864) - before any write. That argument
-- does not hold, for two independent reasons.
--
-- The advisory key is namespaced to the cancel operation -
-- 'dasher:agent-run-cancel-operation:v1|' - so it serializes cancel against
-- cancel and against nothing else. dasher.audit_events.audit_event_id is a
-- single global primary key, and dasher_api.request_agent_run,
-- dasher_retention_api.purge_dashboard and the age-out all spend it from their
-- own caller-supplied parameters under no such key. A concurrent
-- request_agent_run therefore takes no lock this function waits on, and the
-- cancel's probe and INSERT are not serialized against it at all: the id is
-- spent between them and the INSERT raises a bare 23505 carrying the
-- constraint name of dasher.audit_events, on dasher_api, to an ordinary tenant
-- caller. That is the outcome this series does not permit for a duplicate
-- non-idempotent operation - the message confirms that some other row already
-- holds a caller-chosen uuid, which is a cross-tenant existence oracle, and it
-- names a constraint. The other five sites normalize it; this one did not.
--
-- The probe-then-INSERT ordering is also only serializing under READ
-- COMMITTED, where the probe takes a fresh snapshot. This series pins the
-- isolation level on the retention path alone
-- (dasher_retention_api.initialize_operator_context), never on dasher_api, so a
-- tenant caller may run at REPEATABLE READ or SERIALIZABLE, where the probe
-- reads the transaction's pinned snapshot, cannot see an audit row committed
-- after it began, and the INSERT again raises a bare 23505. Reproduced on
-- PostgreSQL 16.14.
--
-- Wrapping closes both holes at once, because the handler catches the
-- unique_violation the global primary key raises no matter which entry point
-- spent the id and no matter what isolation level the caller chose. The lock
-- and the probe stay exactly as frozen: they are still the cheaper, earlier
-- refusal for the cancel-against-cancel case this function was written for, and
-- the wrapper is the backstop for every case they cannot see. Nothing is
-- removed; one handler is added.
--
-- The re-issued body below is byte-identical to the frozen 0007 definition
-- apart from CREATE FUNCTION becoming CREATE OR REPLACE FUNCTION, and the audit
-- INSERT being wrapped in the same block Parts 6, 7 and 8 use. Signature,
-- SECURITY DEFINER, search path, volatility, every declaration, both advisory
-- locks, the cancel-operation probe, every row mark, every security_phase
-- transition, every proof preimage and every other RAISE are preserved.
--
-- Only the single INSERT statement is inside the block. Every row mark this
-- function takes was taken earlier and stays in the outer transaction, so none
-- of them is released by the subtransaction the block opens. The nested block
-- frozen 0007 already carries around its cancel-reason decode - whose handler
-- catches character_not_in_repertoire and invalid_text_representation - is
-- untouched and is unrelated. The handler re-raises rather than swallowing, so
-- the block's subtransaction unwinds the audit INSERT and the propagating
-- exception unwinds everything the call had already done - the cancel event,
-- the attempt releases, the budget refunds - leaving the organization exactly
-- as it was before the call. This normalizes an error; it does not widen a read
-- and it does not change what is written.
--
-- A routine definition is part of the inventory the phase fingerprints hash, so
-- this part moves the phase-8 fingerprint. It does not move the entry count:
-- replacing a body renames no identity.

CREATE OR REPLACE FUNCTION dasher_api.cancel_agent_run(
  p_run_id uuid,
  p_expected_run_revision bigint,
  p_canonical_cancel_reason_bytes bytea,
  p_cancel_operation_and_audit_id uuid,
  p_current_csrf_key_version smallint,
  p_current_csrf_digest bytea,
  p_deployment_revision text
)
RETURNS dasher_api.agent_run_mutation_result
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_organization_id uuid := dasher_private.context_organization_id();
  v_user_id uuid := dasher_private.context_user_id();
  v_membership_id uuid := dasher_private.context_membership_id();
  v_authority_revision bigint := dasher_private.context_authority_revision();
  v_request_id uuid := dasher_private.context_request_id();
  v_run dasher.agent_runs%ROWTYPE;
  v_operation_run dasher.agent_runs%ROWTYPE;
  v_operation_audit dasher.audit_events%ROWTYPE;
  v_cancel_event dasher.agent_run_events%ROWTYPE;
  v_expected_result_sha bytea;
  v_reason_sha bytea;
  v_operation_sha bytea;
  v_released uuid[];
  v_charged uuid[];
  v_mutation record;
  v_zero dasher.agent_run_attempts.used_vector%TYPE :=
    ROW(0,0,0,0,0,0,0,0,0,0,0,0,0,0);
  v_charged_used dasher.agent_run_attempts.used_vector%TYPE;
  v_charged_released dasher.agent_run_attempts.released_vector%TYPE;
  v_attempt dasher.agent_run_attempts%ROWTYPE;
  v_field record;
  v_used_total dasher.agent_run_attempts.used_vector%TYPE :=
    ROW(0,0,0,0,0,0,0,0,0,0,0,0,0,0);
  v_released_total dasher.agent_run_attempts.released_vector%TYPE :=
    ROW(0,0,0,0,0,0,0,0,0,0,0,0,0,0);
  v_used_total_json jsonb;
  v_released_total_json jsonb;
BEGIN
  IF p_run_id IS NULL OR p_expected_run_revision < 1
    OR p_cancel_operation_and_audit_id IS NULL
    OR p_cancel_operation_and_audit_id = v_request_id
    OR p_canonical_cancel_reason_bytes IS NULL
    OR pg_catalog.octet_length(p_canonical_cancel_reason_bytes) NOT BETWEEN 1 AND 4096
    OR pg_catalog.octet_length(p_current_csrf_digest) <> 32
    OR p_deployment_revision IS NULL
    OR pg_catalog.char_length(p_deployment_revision) NOT BETWEEN 1 AND 64
    OR p_deployment_revision <> pg_catalog.btrim(p_deployment_revision)
    OR NOT dasher_private.context_allows(v_organization_id, 'editor')
    OR NOT dasher_private.context_csrf_allows(
      p_current_csrf_key_version, p_current_csrf_digest
    )
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  BEGIN
    IF pg_catalog.convert_from(p_canonical_cancel_reason_bytes, 'UTF8')
        <> '{"reason":"user_requested","schema":"run-cancel-reason-v1"}'
      OR pg_catalog.jsonb_typeof(
        pg_catalog.convert_from(p_canonical_cancel_reason_bytes, 'UTF8')::jsonb
      ) <> 'object'
    THEN
      RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
    END IF;
  EXCEPTION WHEN character_not_in_repertoire OR invalid_text_representation THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END;
  v_reason_sha := pg_catalog.sha256(
    pg_catalog.convert_to('dasher.run-cancel-reason.v1', 'UTF8')
    || pg_catalog.decode('00', 'hex')
    || pg_catalog.int4send(pg_catalog.octet_length(p_canonical_cancel_reason_bytes))
    || p_canonical_cancel_reason_bytes
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'dasher:agent-run-cancel-operation:v1|'
        || p_cancel_operation_and_audit_id::text,
      0
    )
  );
  PERFORM pg_catalog.set_config(
    'dasher.security_capability', 'cancel_agent_run', true
  );
  PERFORM pg_catalog.set_config('dasher.security_run_id', p_run_id::text, true);
  PERFORM pg_catalog.set_config(
    'dasher.security_cancel_operation_id',
    p_cancel_operation_and_audit_id::text,
    true
  );
  PERFORM pg_catalog.set_config(
    'dasher.security_phase', 'cancel_operation_probe', true
  );
  SELECT run.* INTO v_operation_run
  FROM dasher.agent_runs AS run
  WHERE run.tenant_cancel_operation_id = p_cancel_operation_and_audit_id;
  SELECT audit.* INTO v_operation_audit
  FROM dasher.audit_events AS audit
  WHERE audit.audit_event_id = p_cancel_operation_and_audit_id;
  IF FOUND AND v_operation_run.tenant_cancel_operation_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  IF v_operation_run.tenant_cancel_operation_id IS NOT NULL AND (
    v_operation_run.organization_id <> v_organization_id
    OR v_operation_run.run_id <> p_run_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  PERFORM pg_catalog.set_config('dasher.security_phase', 'discovering', true);
  SELECT run.* INTO v_run
  FROM dasher.agent_runs AS run
  WHERE run.organization_id = v_organization_id AND run.run_id = p_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  PERFORM pg_catalog.set_config(
    'dasher.security_dashboard_id', v_run.dashboard_id::text, true
  );
  PERFORM pg_catalog.set_config('dasher.security_phase', 'authorized', true);
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('dasher:organization:v1|' || v_organization_id::text, 0)
  );
  PERFORM 1 FROM dasher.memberships AS membership
  WHERE membership.organization_id = v_organization_id
    AND membership.membership_id = v_membership_id
    AND membership.user_id = v_user_id
    AND membership.authority_revision = v_authority_revision
    AND membership.state = 'active' AND membership.role IN ('editor', 'admin')
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  PERFORM 1 FROM dasher.dashboard_lifecycle_policies AS lifecycle_policy
  WHERE lifecycle_policy.organization_id = v_organization_id
  ORDER BY lifecycle_policy.policy_revision DESC
  LIMIT 1
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  PERFORM 1 FROM dasher.agent_run_policy_revisions AS policy
  WHERE policy.policy_revision = v_run.policy_revision AND policy.enabled
  FOR UPDATE;
  IF NOT FOUND OR NOT dasher_private.validate_agent_run_policy_chain_v1() THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  PERFORM 1 FROM dasher.dashboards AS dashboard
  WHERE dashboard.organization_id = v_organization_id
    AND dashboard.dashboard_id = v_run.dashboard_id
    AND dashboard.lifecycle_state <> 'cleaned'
    AND dashboard.purged_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  SELECT locked_run.* INTO STRICT v_run
  FROM dasher.agent_runs AS locked_run
  WHERE locked_run.organization_id = v_organization_id
    AND locked_run.dashboard_id = v_run.dashboard_id
    AND locked_run.run_id = p_run_id
  FOR UPDATE;
  v_operation_sha := pg_catalog.sha256(
    pg_catalog.convert_to('dasher.run-tenant-cancel-operation.v1', 'UTF8')
    || pg_catalog.decode('00', 'hex')
    || pg_catalog.uuid_send(p_cancel_operation_and_audit_id)
    || pg_catalog.uuid_send(v_organization_id)
    || pg_catalog.uuid_send(v_run.dashboard_id)
    || pg_catalog.uuid_send(p_run_id)
    || pg_catalog.int8send(p_expected_run_revision)
    || v_reason_sha
    || pg_catalog.int8send(p_current_csrf_key_version::bigint)
    || p_current_csrf_digest
    || pg_catalog.int4send(pg_catalog.octet_length(p_deployment_revision))
    || pg_catalog.convert_to(p_deployment_revision, 'UTF8')
    || pg_catalog.uuid_send(v_user_id)
    || pg_catalog.uuid_send(v_membership_id)
    || pg_catalog.int8send(v_authority_revision)
  );
  IF v_run.requesting_user_id <> v_user_id
    OR v_run.requesting_membership_id <> v_membership_id
    OR v_run.requesting_authority_revision <> v_authority_revision
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  IF v_run.tenant_cancel_operation_id IS NOT NULL THEN
    SELECT event.* INTO v_cancel_event
    FROM dasher.agent_run_events AS event
    WHERE event.organization_id = v_run.organization_id
      AND event.dashboard_id = v_run.dashboard_id
      AND event.run_id = v_run.run_id
      AND event.event_sequence = v_run.tenant_cancel_result_event_sequence
      AND event.event_sha256 = v_run.tenant_cancel_result_event_sha256
      AND event.event_kind = 'run_cancelled';
    v_expected_result_sha := pg_catalog.sha256(
      pg_catalog.convert_to('dasher.run-tenant-cancel-result.v1', 'UTF8')
      || pg_catalog.decode('00', 'hex')
      || v_operation_sha
      || pg_catalog.uuid_send(v_run.organization_id)
      || pg_catalog.uuid_send(v_run.dashboard_id)
      || pg_catalog.uuid_send(v_run.run_id)
      || pg_catalog.int8send(v_run.tenant_cancel_result_run_revision)
      || pg_catalog.int4send(pg_catalog.octet_length('cancelled'))
      || pg_catalog.convert_to('cancelled', 'UTF8')
      || pg_catalog.int8send(v_run.tenant_cancel_result_event_sequence)
      || v_run.tenant_cancel_result_event_sha256
    );
    IF v_run.tenant_cancel_operation_id <> p_cancel_operation_and_audit_id
      OR v_run.tenant_cancel_operation_sha256 <> v_operation_sha
      OR v_run.tenant_cancel_result_sha256 <> v_expected_result_sha
      OR v_run.state <> 'cancelled'
      OR v_run.run_revision <> v_run.tenant_cancel_result_run_revision
      OR v_run.current_event_sequence <>
        v_run.tenant_cancel_result_event_sequence
      OR v_run.current_event_sha256 <>
        v_run.tenant_cancel_result_event_sha256
      OR v_cancel_event.event_id IS NULL
      OR v_cancel_event.event_id <> p_cancel_operation_and_audit_id
      OR v_cancel_event.event_sequence <> v_run.current_event_sequence
      OR v_cancel_event.event_sha256 <> v_run.current_event_sha256
      OR v_operation_audit.audit_event_id IS NULL
      OR v_operation_audit.organization_id <> v_run.organization_id
      OR v_operation_audit.occurred_at <> v_cancel_event.occurred_at
      OR v_operation_audit.actor_kind <> 'user'
      OR v_operation_audit.actor_user_id <> v_user_id
      OR v_operation_audit.actor_service IS NOT NULL
      OR v_operation_audit.authority_revision <> v_authority_revision
      OR v_operation_audit.request_id IS NULL
      OR v_operation_audit.job_id IS NOT NULL
      OR v_operation_audit.action <> 'dashboard.agent_run_cancelled'
      OR v_operation_audit.target_type <> 'agent_run'
      OR v_operation_audit.target_id <> v_run.run_id
      OR v_operation_audit.outcome <> 'succeeded'
      OR v_operation_audit.content_sha256 <> v_operation_sha
      OR v_operation_audit.source_ref IS NOT NULL
      OR v_operation_audit.provider IS NOT NULL
      OR v_operation_audit.credential_version IS NOT NULL
      OR v_operation_audit.usage_units IS NOT NULL
      OR v_operation_audit.cost_minor_units IS NOT NULL
      OR v_operation_audit.deployment_revision <> p_deployment_revision
    THEN
      RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
    END IF;
    RETURN ROW(v_run.run_id, v_run.tenant_cancel_result_run_revision,
      v_run.state, v_run.tenant_cancel_result_event_sequence,
      v_run.tenant_cancel_result_event_sha256
    )::dasher_api.agent_run_mutation_result;
  END IF;
  IF v_run.run_revision <> p_expected_run_revision
    OR v_run.state NOT IN (
      'requested','authorized','planning','generating','revising','validating',
      'approval_required'
    )
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;
  PERFORM 1
  FROM dasher.agent_run_budget_counters AS counter
  WHERE counter.organization_id = v_run.organization_id
    AND counter.dashboard_id = v_run.dashboard_id
    AND counter.run_id = v_run.run_id
  ORDER BY CASE counter.partition WHEN 'generation' THEN 0 ELSE 1 END,
    counter.vector_field
  FOR UPDATE;
  FOR v_attempt IN
    SELECT attempt.* FROM dasher.agent_run_attempts AS attempt
    WHERE attempt.organization_id = v_run.organization_id
      AND attempt.dashboard_id = v_run.dashboard_id AND attempt.run_id = v_run.run_id
      AND attempt.state IN ('reserved_pre_dispatch', 'dispatch_ready', 'dispatch_started')
    ORDER BY pg_catalog.uuid_send(attempt.attempt_id) FOR UPDATE
  LOOP
    FOR v_field IN
      SELECT reserved.key AS vector_field,
        CASE WHEN v_attempt.state = 'dispatch_started'
              AND reserved.key <> 'candidates'
          THEN reserved.value::bigint ELSE 0 END AS used_units,
        CASE WHEN v_attempt.state = 'dispatch_started'
              AND reserved.key <> 'candidates'
          THEN 0 ELSE reserved.value::bigint END AS released_units
      FROM pg_catalog.jsonb_each_text(
        pg_catalog.to_jsonb(v_attempt.reserved_vector)
      ) AS reserved
      ORDER BY reserved.key
    LOOP
      UPDATE dasher.agent_run_budget_counters AS counter
      SET used_units = counter.used_units + v_field.used_units,
        released_units = counter.released_units + v_field.released_units,
        updated_at = pg_catalog.statement_timestamp()
      WHERE counter.organization_id = v_run.organization_id
        AND counter.dashboard_id = v_run.dashboard_id AND counter.run_id = v_run.run_id
        AND counter.partition = v_attempt.partition
        AND counter.vector_field = v_field.vector_field;
    END LOOP;
    IF v_attempt.state = 'dispatch_started' THEN
      v_charged := pg_catalog.array_append(v_charged, v_attempt.attempt_id);
      v_charged_used := ROW(
        (v_attempt.reserved_vector).calls,0,
        (v_attempt.reserved_vector).specialist_attempts,
        (v_attempt.reserved_vector).reviewer_attempts,
        (v_attempt.reserved_vector).repair_attempts,
        (v_attempt.reserved_vector).input_tokens,
        (v_attempt.reserved_vector).output_tokens,
        (v_attempt.reserved_vector).reasoning_tokens,
        (v_attempt.reserved_vector).cache_read_tokens,
        (v_attempt.reserved_vector).cache_write_tokens,
        (v_attempt.reserved_vector).total_tokens,
        (v_attempt.reserved_vector).wall_millis,
        (v_attempt.reserved_vector).work_millis,
        (v_attempt.reserved_vector).cost_micros
      );
      v_charged_released := ROW(
        0,(v_attempt.reserved_vector).candidates,0,0,0,0,0,0,0,0,0,0,0,0
      );
      UPDATE dasher.agent_run_attempts AS attempt
      SET state = 'cancelled_charged', actual_vector = NULL,
        used_vector = v_charged_used,
        released_vector = v_charged_released,
        outstanding_vector = v_zero, reconciled_at = pg_catalog.statement_timestamp(),
        terminal_reason_sha256 = v_reason_sha
      WHERE attempt.organization_id = v_run.organization_id
        AND attempt.dashboard_id = v_run.dashboard_id AND attempt.run_id = v_run.run_id
        AND attempt.attempt_id = v_attempt.attempt_id;
      v_mutation := dasher_private.append_agent_run_event_v1(
        v_run.run_id,
        dasher_private.uuid_v8_from_sha256_v1(pg_catalog.sha256(
          pg_catalog.convert_to('dasher.cancel-charged-event-id.v1', 'UTF8')
          || pg_catalog.decode('00', 'hex')
          || pg_catalog.uuid_send(p_cancel_operation_and_audit_id)
          || pg_catalog.uuid_send(v_attempt.attempt_id)
        )),
        'attempt_cancelled_charged',
        pg_catalog.convert_to(pg_catalog.jsonb_build_object(
          'attempt_id', v_attempt.attempt_id::text,
          'cancel_operation_id', p_cancel_operation_and_audit_id::text,
          'released_vector', pg_catalog.to_jsonb(v_charged_released),
          'used_vector', pg_catalog.to_jsonb(v_charged_used)
        )::text, 'UTF8')
      );
    ELSE
      v_released := pg_catalog.array_append(v_released, v_attempt.attempt_id);
      UPDATE dasher.agent_run_attempts AS attempt
      SET state = 'cancelled_released', used_vector = v_zero,
        released_vector = v_attempt.reserved_vector, outstanding_vector = v_zero,
        reconciled_at = pg_catalog.statement_timestamp(),
        terminal_reason_sha256 = v_reason_sha
      WHERE attempt.organization_id = v_run.organization_id
        AND attempt.dashboard_id = v_run.dashboard_id AND attempt.run_id = v_run.run_id
        AND attempt.attempt_id = v_attempt.attempt_id;
      v_mutation := dasher_private.append_agent_run_event_v1(
        v_run.run_id,
        dasher_private.uuid_v8_from_sha256_v1(pg_catalog.sha256(
          pg_catalog.convert_to('dasher.cancel-released-event-id.v1', 'UTF8')
          || pg_catalog.decode('00', 'hex')
          || pg_catalog.uuid_send(p_cancel_operation_and_audit_id)
          || pg_catalog.uuid_send(v_attempt.attempt_id)
        )),
        'attempt_cancelled_released',
        pg_catalog.convert_to(pg_catalog.jsonb_build_object(
          'attempt_id', v_attempt.attempt_id::text,
          'cancel_operation_id', p_cancel_operation_and_audit_id::text,
          'released_vector', pg_catalog.to_jsonb(v_attempt.reserved_vector),
          'used_vector', pg_catalog.to_jsonb(v_zero)
        )::text, 'UTF8')
      );
    END IF;
    SELECT current_run.* INTO STRICT v_run
    FROM dasher.agent_runs AS current_run
    WHERE current_run.organization_id = v_organization_id
      AND current_run.dashboard_id = v_run.dashboard_id
      AND current_run.run_id = p_run_id
    FOR UPDATE;
  END LOOP;
  SELECT pg_catalog.jsonb_build_object(
    'calls', COALESCE(pg_catalog.sum((attempt.used_vector).calls),0),
    'candidates', COALESCE(pg_catalog.sum((attempt.used_vector).candidates),0),
    'specialist_attempts', COALESCE(pg_catalog.sum(
      (attempt.used_vector).specialist_attempts
    ),0),
    'reviewer_attempts', COALESCE(pg_catalog.sum(
      (attempt.used_vector).reviewer_attempts
    ),0),
    'repair_attempts', COALESCE(pg_catalog.sum(
      (attempt.used_vector).repair_attempts
    ),0),
    'input_tokens', COALESCE(pg_catalog.sum(
      (attempt.used_vector).input_tokens
    ),0),
    'output_tokens', COALESCE(pg_catalog.sum(
      (attempt.used_vector).output_tokens
    ),0),
    'reasoning_tokens', COALESCE(pg_catalog.sum(
      (attempt.used_vector).reasoning_tokens
    ),0),
    'cache_read_tokens', COALESCE(pg_catalog.sum(
      (attempt.used_vector).cache_read_tokens
    ),0),
    'cache_write_tokens', COALESCE(pg_catalog.sum(
      (attempt.used_vector).cache_write_tokens
    ),0),
    'total_tokens', COALESCE(pg_catalog.sum(
      (attempt.used_vector).total_tokens
    ),0),
    'wall_millis', COALESCE(pg_catalog.sum(
      (attempt.used_vector).wall_millis
    ),0),
    'work_millis', COALESCE(pg_catalog.sum(
      (attempt.used_vector).work_millis
    ),0),
    'cost_micros', COALESCE(pg_catalog.sum(
      (attempt.used_vector).cost_micros
    ),0)
  ), pg_catalog.jsonb_build_object(
    'calls', COALESCE(pg_catalog.sum((attempt.released_vector).calls),0),
    'candidates', COALESCE(pg_catalog.sum(
      (attempt.released_vector).candidates
    ),0),
    'specialist_attempts', COALESCE(pg_catalog.sum(
      (attempt.released_vector).specialist_attempts
    ),0),
    'reviewer_attempts', COALESCE(pg_catalog.sum(
      (attempt.released_vector).reviewer_attempts
    ),0),
    'repair_attempts', COALESCE(pg_catalog.sum(
      (attempt.released_vector).repair_attempts
    ),0),
    'input_tokens', COALESCE(pg_catalog.sum(
      (attempt.released_vector).input_tokens
    ),0),
    'output_tokens', COALESCE(pg_catalog.sum(
      (attempt.released_vector).output_tokens
    ),0),
    'reasoning_tokens', COALESCE(pg_catalog.sum(
      (attempt.released_vector).reasoning_tokens
    ),0),
    'cache_read_tokens', COALESCE(pg_catalog.sum(
      (attempt.released_vector).cache_read_tokens
    ),0),
    'cache_write_tokens', COALESCE(pg_catalog.sum(
      (attempt.released_vector).cache_write_tokens
    ),0),
    'total_tokens', COALESCE(pg_catalog.sum(
      (attempt.released_vector).total_tokens
    ),0),
    'wall_millis', COALESCE(pg_catalog.sum(
      (attempt.released_vector).wall_millis
    ),0),
    'work_millis', COALESCE(pg_catalog.sum(
      (attempt.released_vector).work_millis
    ),0),
    'cost_micros', COALESCE(pg_catalog.sum(
      (attempt.released_vector).cost_micros
    ),0)
  )
  INTO v_used_total_json, v_released_total_json
  FROM dasher.agent_run_attempts AS attempt
  WHERE attempt.organization_id = v_run.organization_id
    AND attempt.dashboard_id = v_run.dashboard_id
    AND attempt.run_id = v_run.run_id;
  v_used_total := pg_catalog.jsonb_populate_record(
    v_zero, v_used_total_json
  );
  v_released_total := pg_catalog.jsonb_populate_record(
    v_zero, v_released_total_json
  );
  IF EXISTS (
    WITH attempt_components AS (
      SELECT attempt.partition, reserved.key AS vector_field,
        pg_catalog.sum(reserved.value::numeric) AS reserved_units,
        pg_catalog.sum(used.value::numeric) AS used_units,
        pg_catalog.sum(released.value::numeric) AS released_units,
        pg_catalog.sum(outstanding.value::numeric) AS outstanding_units
      FROM dasher.agent_run_attempts AS attempt
      CROSS JOIN LATERAL pg_catalog.jsonb_each_text(
        pg_catalog.to_jsonb(attempt.reserved_vector)
      ) AS reserved
      JOIN LATERAL pg_catalog.jsonb_each_text(
        pg_catalog.to_jsonb(attempt.used_vector)
      ) AS used ON used.key = reserved.key
      JOIN LATERAL pg_catalog.jsonb_each_text(
        pg_catalog.to_jsonb(attempt.released_vector)
      ) AS released ON released.key = reserved.key
      JOIN LATERAL pg_catalog.jsonb_each_text(
        pg_catalog.to_jsonb(attempt.outstanding_vector)
      ) AS outstanding ON outstanding.key = reserved.key
      WHERE attempt.organization_id = v_run.organization_id
        AND attempt.dashboard_id = v_run.dashboard_id
        AND attempt.run_id = v_run.run_id
      GROUP BY attempt.partition, reserved.key
    )
    SELECT 1
    FROM dasher.agent_run_budget_counters AS counter
    LEFT JOIN attempt_components AS component
      ON component.partition = counter.partition
     AND component.vector_field = counter.vector_field
    WHERE counter.organization_id = v_run.organization_id
      AND counter.dashboard_id = v_run.dashboard_id
      AND counter.run_id = v_run.run_id
      AND (
        counter.reserved_units::numeric
          <> COALESCE(component.reserved_units, 0)
        OR counter.used_units::numeric <> COALESCE(component.used_units, 0)
        OR counter.released_units::numeric
          <> COALESCE(component.released_units, 0)
        OR COALESCE(component.outstanding_units, 0) <> 0
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  PERFORM pg_catalog.set_config('dasher.run_organization_id', v_run.organization_id::text, true);
  PERFORM pg_catalog.set_config('dasher.run_dashboard_id', v_run.dashboard_id::text, true);
  PERFORM pg_catalog.set_config('dasher.run_next_state', 'cancelled', true);
  PERFORM pg_catalog.set_config('dasher.run_clear_lease', 'true', true);
  PERFORM pg_catalog.set_config('dasher.run_terminal_reason_sha256', pg_catalog.encode(v_reason_sha, 'hex'), true);
  PERFORM pg_catalog.set_config('dasher.run_tenant_cancel_operation_id', p_cancel_operation_and_audit_id::text, true);
  PERFORM pg_catalog.set_config('dasher.run_tenant_cancel_operation_sha256', pg_catalog.encode(v_operation_sha, 'hex'), true);
  v_mutation := dasher_private.append_agent_run_event_v1(
    v_run.run_id, p_cancel_operation_and_audit_id, 'run_cancelled',
    pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'cancel_operation_id', p_cancel_operation_and_audit_id::text,
      'cancel_operation_sha256', pg_catalog.encode(v_operation_sha, 'hex'),
      'charged_attempt_ids', COALESCE(pg_catalog.to_jsonb(v_charged), '[]'::jsonb),
      'fenced_lease_epoch', 'i64:' || (v_run.lease_epoch + 1)::text,
      'reason_sha256', pg_catalog.encode(v_reason_sha, 'hex'),
      'released_attempt_ids', COALESCE(pg_catalog.to_jsonb(v_released), '[]'::jsonb),
      'released_vector', pg_catalog.to_jsonb(v_released_total),
      'used_vector', pg_catalog.to_jsonb(v_used_total)
    )::text, 'UTF8')
  );
  BEGIN
    INSERT INTO dasher.audit_events (
      audit_event_id, organization_id, occurred_at, actor_kind, actor_user_id,
      actor_service, authority_revision, request_id, job_id, action,
      target_type, target_id, outcome, content_sha256, source_ref, provider,
      credential_version, usage_units, cost_minor_units, deployment_revision
    ) VALUES (
      p_cancel_operation_and_audit_id, v_run.organization_id,
      pg_catalog.statement_timestamp(), 'user', v_user_id, NULL,
      v_authority_revision, v_request_id, NULL, 'dashboard.agent_run_cancelled',
      'agent_run', p_run_id, 'succeeded', v_operation_sha,
      NULL, NULL, NULL, NULL, NULL,
      p_deployment_revision
    );
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END;
  RETURN ROW(v_mutation.run_id, v_mutation.run_revision, v_mutation.state,
    v_mutation.event_sequence, v_mutation.event_sha256
  )::dasher_api.agent_run_mutation_result;
END
$function$;
