-- Dasher immutable-content and lifecycle successor.
-- SQL creates no roles; the migrator prepares the exact retention pair.

ALTER TABLE dasher.audit_events
  DROP CONSTRAINT audit_events_action_check;
ALTER TABLE dasher.audit_events
  ADD CONSTRAINT audit_events_action_check CHECK (((action)::text = ANY ((ARRAY['membership.role_changed'::character varying, 'membership.revoked'::character varying, 'invitation.issued'::character varying, 'invitation.revoked'::character varying, 'invitation.accepted'::character varying, 'invitation.accepted_existing_membership'::character varying, 'session.issued'::character varying, 'session.rotated'::character varying, 'session.revoked'::character varying, 'source_snapshot.created'::character varying, 'evidence_record.created'::character varying, 'dashboard.created'::character varying, 'dashboard_version.created'::character varying, 'dashboard_head.promoted'::character varying, 'dashboard.promotion_requested'::character varying, 'dashboard.promotion_approved'::character varying, 'dashboard.promotion_denied'::character varying, 'dashboard.expired'::character varying, 'dashboard.archived'::character varying, 'dashboard.unarchived'::character varying, 'dashboard.deleted'::character varying, 'dashboard.restored_as_new'::character varying, 'dashboard.cleanup_started'::character varying, 'dashboard.purge_eligible'::character varying, 'dashboard.legal_hold_placed'::character varying, 'dashboard.legal_hold_released'::character varying, 'dashboard.purged'::character varying, 'dashboard.artifact_created'::character varying])::text[])));

CREATE SCHEMA dasher_retention_api AUTHORIZATION CURRENT_USER;
REVOKE ALL ON SCHEMA dasher_retention_api FROM PUBLIC, dasher_app, dasher_security_definer, dasher_retention_definer, dasher_retention_operator;

CREATE TYPE dasher.dashboard_summary AS (
  dashboard_id uuid,
  title text,
  current_kind text,
  lifecycle_state text,
  lifecycle_revision bigint,
  effective_expires_at timestamptz,
  head_version_id uuid
);

CREATE TYPE dasher.dashboard_version_projection AS (
  dashboard_id uuid,
  version_id uuid,
  parent_version_id uuid,
  canonical_spec_bytes bytea,
  canonical_spec_sha256 bytea,
  validation_state text,
  validation_sha256 bytea,
  planner_provenance_sha256 bytea,
  policy_revision bigint,
  registry_revision bigint,
  calculation_graph_sha256 bytea,
  created_at timestamptz
);

CREATE TYPE dasher.dashboard_evidence_projection AS (
  dashboard_id uuid,
  version_id uuid,
  evidence_id uuid,
  evidence_kind text,
  content_sha256 bytea,
  observed_at timestamptz,
  retrieved_at timestamptz
);

CREATE TYPE dasher.dashboard_lineage_projection AS (
  dashboard_id uuid,
  version_id uuid,
  parent_version_id uuid,
  snapshot_id uuid,
  evidence_id uuid,
  artifact_id uuid
);

CREATE TYPE dasher.dashboard_admin_projection AS (
  dashboard_id uuid,
  lifecycle_state text,
  lifecycle_revision bigint,
  capability_epoch bigint,
  cache_epoch bigint,
  access_revoked_at timestamptz,
  purge_after timestamptz,
  purge_started_at timestamptz,
  purged_at timestamptz,
  active_hold_count bigint,
  cleanup_step text
);

CREATE TABLE dasher.dashboard_lifecycle_policies (
  organization_id uuid NOT NULL,
  policy_revision bigint NOT NULL,
  default_disposable_ttl_seconds integer NOT NULL,
  retention_policy_revision bigint NOT NULL,
  created_at timestamp with time zone NOT NULL,
  created_by_user_id uuid NOT NULL,
  provenance text NOT NULL
);

CREATE TABLE dasher.dashboards (
  organization_id uuid NOT NULL,
  dashboard_id uuid NOT NULL,
  title text NOT NULL,
  created_by_user_id uuid NOT NULL,
  created_at timestamp with time zone NOT NULL,
  created_kind text NOT NULL,
  current_kind text NOT NULL,
  original_expires_at timestamp with time zone,
  effective_expires_at timestamp with time zone,
  lifecycle_state text NOT NULL,
  lifecycle_revision bigint NOT NULL,
  capability_epoch bigint NOT NULL,
  cache_epoch bigint NOT NULL,
  access_revoked_at timestamp with time zone,
  revocation_reason text,
  purge_after timestamp with time zone,
  purge_started_at timestamp with time zone,
  purged_at timestamp with time zone,
  retention_policy_revision bigint NOT NULL,
  promoted_at timestamp with time zone,
  archived_at timestamp with time zone,
  head_version_id uuid,
  tombstone_lineage_id uuid NOT NULL,
  restored_from_tombstone_lineage_id uuid
);

CREATE TABLE dasher.dashboard_lifecycle_events (
  lifecycle_event_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  dashboard_id uuid NOT NULL,
  lifecycle_revision bigint NOT NULL,
  event_kind text NOT NULL,
  from_kind text,
  to_kind text,
  from_state text,
  to_state text,
  occurred_at timestamp with time zone NOT NULL,
  actor_user_id uuid,
  actor_service text,
  authority_revision bigint NOT NULL,
  retention_policy_revision bigint NOT NULL,
  request_id uuid NOT NULL,
  job_id uuid,
  reason_sha256 bytea NOT NULL
);

CREATE TABLE dasher.dashboard_promotion_requests (
  organization_id uuid NOT NULL,
  promotion_request_id uuid NOT NULL,
  dashboard_id uuid NOT NULL,
  requested_lifecycle_revision bigint NOT NULL,
  requested_at timestamp with time zone NOT NULL,
  requested_by_user_id uuid NOT NULL,
  rationale_sha256 bytea NOT NULL
);

CREATE TABLE dasher.dashboard_promotion_decisions (
  organization_id uuid NOT NULL,
  promotion_request_id uuid NOT NULL,
  decision text NOT NULL,
  dashboard_lifecycle_revision bigint NOT NULL,
  decided_at timestamp with time zone NOT NULL,
  requested_by_user_id uuid NOT NULL,
  decided_by_user_id uuid NOT NULL,
  retention_policy_revision bigint NOT NULL
);

CREATE TABLE dasher.dashboard_cleanup_coordination (
  organization_id uuid NOT NULL,
  dashboard_id uuid NOT NULL,
  current_step text NOT NULL,
  lease_owner name,
  lease_expires_at timestamp with time zone,
  expected_lifecycle_revision bigint NOT NULL,
  next_attempt_at timestamp with time zone,
  completion_proof_sha256 bytea
);

CREATE TABLE dasher.dashboard_cleanup_attempts (
  organization_id uuid NOT NULL,
  dashboard_id uuid NOT NULL,
  cleanup_attempt_id uuid NOT NULL,
  step text NOT NULL,
  started_at timestamp with time zone NOT NULL,
  finished_at timestamp with time zone,
  result text NOT NULL,
  released_claim_count integer NOT NULL,
  deleted_resource_count integer NOT NULL,
  deferred_claim_count integer NOT NULL,
  failure_code text,
  proof_sha256 bytea
);

CREATE TABLE dasher.dashboard_legal_holds (
  organization_id uuid NOT NULL,
  dashboard_id uuid NOT NULL,
  hold_id uuid NOT NULL,
  case_matter_reference text NOT NULL,
  placed_by_principal_id uuid NOT NULL,
  placed_authority_revision bigint NOT NULL,
  placed_actor text NOT NULL,
  placed_reason_sha256 bytea NOT NULL,
  placed_at timestamp with time zone NOT NULL,
  retention_policy_revision bigint NOT NULL,
  released_at timestamp with time zone,
  released_by_principal_id uuid,
  released_authority_revision bigint,
  released_actor text,
  released_reason_sha256 bytea
);

CREATE TABLE dasher.dashboard_tombstones (
  organization_id uuid NOT NULL,
  tombstone_lineage_id uuid NOT NULL,
  retention_policy_revision bigint NOT NULL,
  access_revoked_at timestamp with time zone NOT NULL,
  access_revoked_lifecycle_revision bigint NOT NULL,
  access_revoked_proof_sha256 bytea NOT NULL,
  purged_at timestamp with time zone,
  purged_lifecycle_revision bigint,
  purged_proof_sha256 bytea
);

CREATE TABLE dasher.dashboard_restore_lineage (
  organization_id uuid NOT NULL,
  dashboard_id uuid NOT NULL,
  version_id uuid NOT NULL,
  source_tombstone_lineage_id uuid NOT NULL,
  source_version_id uuid NOT NULL,
  retention_policy_revision bigint NOT NULL,
  actor_user_id uuid,
  authority_revision bigint NOT NULL,
  occurred_at timestamp with time zone NOT NULL,
  provenance_sha256 bytea NOT NULL
);

CREATE TABLE dasher.backup_deletion_ledger (
  organization_id uuid NOT NULL,
  ledger_sequence bigint NOT NULL,
  tombstone_lineage_id uuid NOT NULL,
  lifecycle_revision bigint NOT NULL,
  event_kind text NOT NULL,
  event_occurred_at timestamp with time zone NOT NULL,
  inserted_at timestamp with time zone NOT NULL,
  retention_policy_revision bigint NOT NULL,
  proof_sha256 bytea
);

CREATE TABLE dasher.retention_service_principal_allowlist (
  retention_service_principal_id uuid NOT NULL,
  principal_revision bigint NOT NULL,
  binding_kind text NOT NULL,
  binding_subject name NOT NULL,
  authority_scope text NOT NULL,
  scope_organization_id uuid,
  can_initialize boolean NOT NULL,
  can_materialize_expiry boolean NOT NULL,
  can_place_hold boolean NOT NULL,
  can_release_hold boolean NOT NULL,
  can_claim_cleanup boolean NOT NULL,
  can_record_attempt boolean NOT NULL,
  can_purge boolean NOT NULL,
  enabled boolean NOT NULL,
  created_at timestamp with time zone NOT NULL,
  predecessor_revision bigint,
  predecessor_sha256 bytea,
  revision_sha256 bytea NOT NULL,
  migration_provenance text NOT NULL
);

CREATE TABLE dasher.source_snapshots (
  organization_id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  source_kind text NOT NULL,
  canonical_bytes bytea NOT NULL,
  content_sha256 bytea NOT NULL,
  observed_at timestamp with time zone NOT NULL,
  retrieved_at timestamp with time zone NOT NULL,
  created_at timestamp with time zone NOT NULL
);

CREATE TABLE dasher.evidence_records (
  organization_id uuid NOT NULL,
  evidence_id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  evidence_kind text NOT NULL,
  coordinates text NOT NULL,
  transformation text NOT NULL,
  content_sha256 bytea NOT NULL,
  observed_at timestamp with time zone NOT NULL,
  retrieved_at timestamp with time zone NOT NULL,
  created_at timestamp with time zone NOT NULL
);

CREATE TABLE dasher.dashboard_versions (
  organization_id uuid NOT NULL,
  dashboard_id uuid NOT NULL,
  version_id uuid NOT NULL,
  parent_version_id uuid,
  canonical_spec_bytes bytea NOT NULL,
  canonical_spec_sha256 bytea NOT NULL,
  validation_state text NOT NULL,
  validation_sha256 bytea NOT NULL,
  planner_provenance_sha256 bytea NOT NULL,
  policy_revision bigint NOT NULL,
  registry_revision bigint NOT NULL,
  calculation_graph_sha256 bytea,
  created_by_user_id uuid NOT NULL,
  created_at timestamp with time zone NOT NULL
);

CREATE TABLE dasher.dashboard_version_snapshots (
  organization_id uuid NOT NULL,
  dashboard_id uuid NOT NULL,
  version_id uuid NOT NULL,
  snapshot_id uuid NOT NULL
);

CREATE TABLE dasher.dashboard_version_evidence (
  organization_id uuid NOT NULL,
  dashboard_id uuid NOT NULL,
  version_id uuid NOT NULL,
  evidence_id uuid NOT NULL
);

CREATE TABLE dasher.dashboard_artifacts (
  organization_id uuid NOT NULL,
  artifact_id uuid NOT NULL,
  dashboard_id uuid,
  version_id uuid,
  ownership_class text NOT NULL,
  artifact_kind text NOT NULL,
  metadata_sha256 bytea NOT NULL,
  content_sha256 bytea NOT NULL,
  created_at timestamp with time zone NOT NULL
);

CREATE TABLE dasher.snapshot_reference_claims (
  organization_id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  reference_claim_id uuid NOT NULL,
  dashboard_id uuid NOT NULL,
  version_id uuid NOT NULL,
  claim_kind text NOT NULL,
  hold_id uuid,
  created_at timestamp with time zone NOT NULL
);

CREATE TABLE dasher.evidence_reference_claims (
  organization_id uuid NOT NULL,
  evidence_id uuid NOT NULL,
  reference_claim_id uuid NOT NULL,
  dashboard_id uuid NOT NULL,
  version_id uuid NOT NULL,
  claim_kind text NOT NULL,
  hold_id uuid,
  created_at timestamp with time zone NOT NULL
);

CREATE TABLE dasher.artifact_reference_claims (
  organization_id uuid NOT NULL,
  artifact_id uuid NOT NULL,
  reference_claim_id uuid NOT NULL,
  dashboard_id uuid NOT NULL,
  version_id uuid NOT NULL,
  claim_kind text NOT NULL,
  hold_id uuid,
  created_at timestamp with time zone NOT NULL
);

CREATE TABLE dasher.snapshot_deletion_finalizers (
  organization_id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  state text NOT NULL,
  intent_at timestamp with time zone NOT NULL,
  expected_claim_set_sha256 bytea NOT NULL,
  lease_owner name,
  lease_expires_at timestamp with time zone,
  proof_sha256 bytea,
  bytes_deleted_at timestamp with time zone
);

CREATE TABLE dasher.evidence_deletion_finalizers (
  organization_id uuid NOT NULL,
  evidence_id uuid NOT NULL,
  state text NOT NULL,
  intent_at timestamp with time zone NOT NULL,
  expected_claim_set_sha256 bytea NOT NULL,
  lease_owner name,
  lease_expires_at timestamp with time zone,
  proof_sha256 bytea,
  bytes_deleted_at timestamp with time zone
);

CREATE TABLE dasher.artifact_deletion_finalizers (
  organization_id uuid NOT NULL,
  artifact_id uuid NOT NULL,
  state text NOT NULL,
  intent_at timestamp with time zone NOT NULL,
  expected_claim_set_sha256 bytea NOT NULL,
  lease_owner name,
  lease_expires_at timestamp with time zone,
  proof_sha256 bytea,
  bytes_deleted_at timestamp with time zone
);

REVOKE ALL ON TYPE dasher.dashboard_lifecycle_policies FROM PUBLIC, dasher_app, dasher_security_definer, dasher_retention_definer, dasher_retention_operator;
REVOKE ALL ON TYPE dasher.dashboards FROM PUBLIC, dasher_app, dasher_security_definer, dasher_retention_definer, dasher_retention_operator;
REVOKE ALL ON TYPE dasher.dashboard_lifecycle_events FROM PUBLIC, dasher_app, dasher_security_definer, dasher_retention_definer, dasher_retention_operator;
REVOKE ALL ON TYPE dasher.dashboard_promotion_requests FROM PUBLIC, dasher_app, dasher_security_definer, dasher_retention_definer, dasher_retention_operator;
REVOKE ALL ON TYPE dasher.dashboard_promotion_decisions FROM PUBLIC, dasher_app, dasher_security_definer, dasher_retention_definer, dasher_retention_operator;
REVOKE ALL ON TYPE dasher.dashboard_cleanup_coordination FROM PUBLIC, dasher_app, dasher_security_definer, dasher_retention_definer, dasher_retention_operator;
REVOKE ALL ON TYPE dasher.dashboard_cleanup_attempts FROM PUBLIC, dasher_app, dasher_security_definer, dasher_retention_definer, dasher_retention_operator;
REVOKE ALL ON TYPE dasher.dashboard_legal_holds FROM PUBLIC, dasher_app, dasher_security_definer, dasher_retention_definer, dasher_retention_operator;
REVOKE ALL ON TYPE dasher.dashboard_tombstones FROM PUBLIC, dasher_app, dasher_security_definer, dasher_retention_definer, dasher_retention_operator;
REVOKE ALL ON TYPE dasher.dashboard_restore_lineage FROM PUBLIC, dasher_app, dasher_security_definer, dasher_retention_definer, dasher_retention_operator;
REVOKE ALL ON TYPE dasher.backup_deletion_ledger FROM PUBLIC, dasher_app, dasher_security_definer, dasher_retention_definer, dasher_retention_operator;
REVOKE ALL ON TYPE dasher.retention_service_principal_allowlist FROM PUBLIC, dasher_app, dasher_security_definer, dasher_retention_definer, dasher_retention_operator;
REVOKE ALL ON TYPE dasher.source_snapshots FROM PUBLIC, dasher_app, dasher_security_definer, dasher_retention_definer, dasher_retention_operator;
REVOKE ALL ON TYPE dasher.evidence_records FROM PUBLIC, dasher_app, dasher_security_definer, dasher_retention_definer, dasher_retention_operator;
REVOKE ALL ON TYPE dasher.dashboard_versions FROM PUBLIC, dasher_app, dasher_security_definer, dasher_retention_definer, dasher_retention_operator;
REVOKE ALL ON TYPE dasher.dashboard_version_snapshots FROM PUBLIC, dasher_app, dasher_security_definer, dasher_retention_definer, dasher_retention_operator;
REVOKE ALL ON TYPE dasher.dashboard_version_evidence FROM PUBLIC, dasher_app, dasher_security_definer, dasher_retention_definer, dasher_retention_operator;
REVOKE ALL ON TYPE dasher.dashboard_artifacts FROM PUBLIC, dasher_app, dasher_security_definer, dasher_retention_definer, dasher_retention_operator;
REVOKE ALL ON TYPE dasher.snapshot_reference_claims FROM PUBLIC, dasher_app, dasher_security_definer, dasher_retention_definer, dasher_retention_operator;
REVOKE ALL ON TYPE dasher.evidence_reference_claims FROM PUBLIC, dasher_app, dasher_security_definer, dasher_retention_definer, dasher_retention_operator;
REVOKE ALL ON TYPE dasher.artifact_reference_claims FROM PUBLIC, dasher_app, dasher_security_definer, dasher_retention_definer, dasher_retention_operator;
REVOKE ALL ON TYPE dasher.snapshot_deletion_finalizers FROM PUBLIC, dasher_app, dasher_security_definer, dasher_retention_definer, dasher_retention_operator;
REVOKE ALL ON TYPE dasher.evidence_deletion_finalizers FROM PUBLIC, dasher_app, dasher_security_definer, dasher_retention_definer, dasher_retention_operator;
REVOKE ALL ON TYPE dasher.artifact_deletion_finalizers FROM PUBLIC, dasher_app, dasher_security_definer, dasher_retention_definer, dasher_retention_operator;

ALTER TABLE dasher.dashboard_lifecycle_policies ADD CONSTRAINT dashboard_lifecycle_policies_pkey PRIMARY KEY (organization_id, policy_revision);
ALTER TABLE dasher.dashboards ADD CONSTRAINT dashboards_pkey PRIMARY KEY (organization_id, dashboard_id);
ALTER TABLE dasher.dashboard_lifecycle_events ADD CONSTRAINT dashboard_lifecycle_events_pkey PRIMARY KEY (organization_id, dashboard_id, lifecycle_revision);
ALTER TABLE dasher.dashboard_promotion_requests ADD CONSTRAINT dashboard_promotion_requests_pkey PRIMARY KEY (organization_id, promotion_request_id);
ALTER TABLE dasher.dashboard_promotion_decisions ADD CONSTRAINT dashboard_promotion_decisions_pkey PRIMARY KEY (organization_id, promotion_request_id);
ALTER TABLE dasher.dashboard_cleanup_coordination ADD CONSTRAINT dashboard_cleanup_coordination_pkey PRIMARY KEY (organization_id, dashboard_id);
ALTER TABLE dasher.dashboard_cleanup_attempts ADD CONSTRAINT dashboard_cleanup_attempts_pkey PRIMARY KEY (organization_id, dashboard_id, cleanup_attempt_id);
ALTER TABLE dasher.dashboard_legal_holds ADD CONSTRAINT dashboard_legal_holds_pkey PRIMARY KEY (organization_id, dashboard_id, hold_id);
ALTER TABLE dasher.dashboard_tombstones ADD CONSTRAINT dashboard_tombstones_pkey PRIMARY KEY (organization_id, tombstone_lineage_id);
ALTER TABLE dasher.dashboard_restore_lineage ADD CONSTRAINT dashboard_restore_lineage_pkey PRIMARY KEY (organization_id, dashboard_id, version_id);
ALTER TABLE dasher.backup_deletion_ledger ADD CONSTRAINT backup_deletion_ledger_pkey PRIMARY KEY (organization_id, ledger_sequence);
ALTER TABLE dasher.retention_service_principal_allowlist ADD CONSTRAINT retention_service_principal_allowlist_pkey PRIMARY KEY (retention_service_principal_id, principal_revision);
ALTER TABLE dasher.source_snapshots ADD CONSTRAINT source_snapshots_pkey PRIMARY KEY (organization_id, snapshot_id);
ALTER TABLE dasher.evidence_records ADD CONSTRAINT evidence_records_pkey PRIMARY KEY (organization_id, evidence_id);
ALTER TABLE dasher.dashboard_versions ADD CONSTRAINT dashboard_versions_pkey PRIMARY KEY (organization_id, dashboard_id, version_id);
ALTER TABLE dasher.dashboard_version_snapshots ADD CONSTRAINT dashboard_version_snapshots_pkey PRIMARY KEY (organization_id, dashboard_id, version_id, snapshot_id);
ALTER TABLE dasher.dashboard_version_evidence ADD CONSTRAINT dashboard_version_evidence_pkey PRIMARY KEY (organization_id, dashboard_id, version_id, evidence_id);
ALTER TABLE dasher.dashboard_artifacts ADD CONSTRAINT dashboard_artifacts_pkey PRIMARY KEY (organization_id, artifact_id);
ALTER TABLE dasher.snapshot_reference_claims ADD CONSTRAINT snapshot_reference_claims_pkey PRIMARY KEY (organization_id, snapshot_id, reference_claim_id);
ALTER TABLE dasher.evidence_reference_claims ADD CONSTRAINT evidence_reference_claims_pkey PRIMARY KEY (organization_id, evidence_id, reference_claim_id);
ALTER TABLE dasher.artifact_reference_claims ADD CONSTRAINT artifact_reference_claims_pkey PRIMARY KEY (organization_id, artifact_id, reference_claim_id);
ALTER TABLE dasher.snapshot_deletion_finalizers ADD CONSTRAINT snapshot_deletion_finalizers_pkey PRIMARY KEY (organization_id, snapshot_id);
ALTER TABLE dasher.evidence_deletion_finalizers ADD CONSTRAINT evidence_deletion_finalizers_pkey PRIMARY KEY (organization_id, evidence_id);
ALTER TABLE dasher.artifact_deletion_finalizers ADD CONSTRAINT artifact_deletion_finalizers_pkey PRIMARY KEY (organization_id, artifact_id);
ALTER TABLE dasher.dashboard_lifecycle_policies ADD CONSTRAINT dashboard_lifecycle_policies_default_ttl_check CHECK (((default_disposable_ttl_seconds >= 3600) AND (default_disposable_ttl_seconds <= 604800)));
ALTER TABLE dasher.dashboards ADD CONSTRAINT dashboards_kind_check CHECK (((created_kind = ANY (ARRAY['disposable'::text, 'durable'::text])) AND (current_kind = ANY (ARRAY['disposable'::text, 'durable'::text]))));
ALTER TABLE dasher.dashboards ADD CONSTRAINT dashboards_lifecycle_state_check CHECK ((lifecycle_state = ANY (ARRAY['draft'::text, 'active'::text, 'archived'::text, 'access_revoked'::text, 'quarantined'::text, 'purge_eligible'::text, 'cleaned'::text])));
ALTER TABLE dasher.dashboards ADD CONSTRAINT dashboards_lifecycle_fences_check CHECK (((lifecycle_revision >= 0) AND (capability_epoch >= 0) AND (cache_epoch >= 0) AND (capability_epoch <= lifecycle_revision) AND (cache_epoch <= lifecycle_revision) AND (retention_policy_revision >= 1) AND ((lifecycle_revision <> 0) OR ((lifecycle_state = 'draft'::text) AND (head_version_id IS NULL) AND (capability_epoch = 0) AND (cache_epoch = 0)))));
ALTER TABLE dasher.dashboards ADD CONSTRAINT dashboards_expiry_kind_check CHECK ((((created_kind = 'durable'::text) AND (current_kind = 'durable'::text) AND (original_expires_at IS NULL) AND (effective_expires_at IS NULL) AND (promoted_at IS NULL)) OR ((created_kind = 'disposable'::text) AND (original_expires_at IS NOT NULL) AND (original_expires_at >= (created_at + '01:00:00'::interval)) AND (original_expires_at <= (created_at + '30 days'::interval)) AND (((current_kind = 'disposable'::text) AND (effective_expires_at = original_expires_at) AND (promoted_at IS NULL)) OR ((current_kind = 'durable'::text) AND (effective_expires_at IS NULL) AND (promoted_at IS NOT NULL))))));
ALTER TABLE dasher.dashboards ADD CONSTRAINT dashboards_revocation_fields_check CHECK (((lifecycle_state = ANY (ARRAY['draft'::text, 'active'::text, 'archived'::text])) AND (access_revoked_at IS NULL) AND (revocation_reason IS NULL) AND (purge_after IS NULL) AND (purge_started_at IS NULL) AND (purged_at IS NULL) OR ((lifecycle_state = ANY (ARRAY['access_revoked'::text, 'quarantined'::text, 'purge_eligible'::text, 'cleaned'::text])) AND (access_revoked_at IS NOT NULL) AND (revocation_reason = ANY (ARRAY['expired'::text, 'explicit_delete'::text])) AND (purge_after = (access_revoked_at + '24:00:00'::interval)) AND (purge_started_at IS NULL OR purge_started_at >= access_revoked_at) AND (purged_at IS NULL OR (purge_started_at IS NOT NULL AND purged_at >= purge_started_at)) AND ((lifecycle_state = 'cleaned'::text) = (purged_at IS NOT NULL)) AND ((purge_started_at IS NULL) OR (lifecycle_state = ANY (ARRAY['purge_eligible'::text, 'cleaned'::text]))))));
ALTER TABLE dasher.dashboards ADD CONSTRAINT dashboards_state_kind_head_check CHECK ((((lifecycle_state <> 'archived'::text) OR (archived_at IS NOT NULL)) AND ((archived_at IS NULL) OR ((current_kind = 'durable'::text) AND (lifecycle_state = ANY (ARRAY['archived'::text, 'access_revoked'::text, 'quarantined'::text, 'purge_eligible'::text, 'cleaned'::text])))) AND ((lifecycle_state <> ALL (ARRAY['active'::text, 'archived'::text])) OR (head_version_id IS NOT NULL)) AND ((lifecycle_state <> ALL (ARRAY['draft'::text, 'cleaned'::text])) OR (head_version_id IS NULL)) AND ((current_kind <> 'disposable'::text) OR (lifecycle_state <> 'archived'::text))));
ALTER TABLE dasher.dashboard_lifecycle_events ADD CONSTRAINT dashboard_lifecycle_events_kind_check CHECK ((event_kind = ANY (ARRAY['head_activated'::text, 'head_advanced'::text, 'promotion_approved'::text, 'archived'::text, 'unarchived'::text, 'expired'::text, 'deleted'::text, 'cleanup_started'::text, 'purge_eligible'::text, 'legal_hold_placed'::text, 'legal_hold_released'::text, 'purged'::text])));
ALTER TABLE dasher.dashboard_lifecycle_events ADD CONSTRAINT dashboard_lifecycle_events_transition_check CHECK ((((event_kind = 'head_activated'::text) AND (from_kind = to_kind) AND (from_state = 'draft'::text) AND (to_state = 'active'::text)) OR ((event_kind = 'head_advanced'::text) AND (from_kind = to_kind) AND (from_state = 'active'::text) AND (to_state = 'active'::text)) OR ((event_kind = 'promotion_approved'::text) AND (from_kind = 'disposable'::text) AND (to_kind = 'durable'::text) AND (from_state = 'active'::text) AND (to_state = 'active'::text)) OR ((event_kind = 'archived'::text) AND (from_kind = 'durable'::text) AND (to_kind = 'durable'::text) AND (from_state = 'active'::text) AND (to_state = 'archived'::text)) OR ((event_kind = 'unarchived'::text) AND (from_kind = 'durable'::text) AND (to_kind = 'durable'::text) AND (from_state = 'archived'::text) AND (to_state = 'active'::text)) OR ((event_kind = ANY (ARRAY['expired'::text, 'deleted'::text])) AND (from_kind = to_kind) AND (from_state = ANY (ARRAY['draft'::text, 'active'::text, 'archived'::text])) AND (to_state = 'access_revoked'::text)) OR ((event_kind = 'cleanup_started'::text) AND (from_kind = to_kind) AND (from_state = 'access_revoked'::text) AND (to_state = 'quarantined'::text)) OR ((event_kind = 'purge_eligible'::text) AND (from_kind = to_kind) AND (from_state = 'quarantined'::text) AND (to_state = 'purge_eligible'::text)) OR ((event_kind = ANY (ARRAY['legal_hold_placed'::text, 'legal_hold_released'::text])) AND (from_kind = to_kind) AND (from_state = to_state)) OR ((event_kind = 'purged'::text) AND (from_kind = to_kind) AND (from_state = 'purge_eligible'::text) AND (to_state = 'cleaned'::text))));
ALTER TABLE dasher.dashboard_lifecycle_events ADD CONSTRAINT dashboard_lifecycle_events_actor_check CHECK ((((actor_user_id IS NOT NULL) AND (actor_service IS NULL)) OR ((actor_user_id IS NULL) AND (actor_service IS NOT NULL))));
ALTER TABLE dasher.dashboard_cleanup_coordination ADD CONSTRAINT dashboard_cleanup_coordination_step_check CHECK ((current_step = ANY (ARRAY['access_revoked'::text, 'drain_and_cancel'::text, 'quarantined'::text, 'prepare_finalizers'::text, 'purge_eligible'::text, 'await_purge'::text, 'purge_started'::text, 'purge_finalizing'::text, 'final_proof_ready'::text, 'cleaned'::text])));
ALTER TABLE dasher.dashboard_cleanup_coordination ADD CONSTRAINT dashboard_cleanup_coordination_lease_check CHECK (((lease_owner IS NULL) = (lease_expires_at IS NULL)));
ALTER TABLE dasher.dashboard_cleanup_attempts ADD CONSTRAINT dashboard_cleanup_attempts_step_check CHECK ((step = ANY (ARRAY['access_revoked'::text, 'drain_and_cancel'::text, 'quarantined'::text, 'prepare_finalizers'::text, 'purge_eligible'::text, 'await_purge'::text, 'purge_started'::text, 'purge_finalizing'::text, 'final_proof_ready'::text, 'finalize_resources'::text, 'cleaned'::text, 'purged'::text])));
ALTER TABLE dasher.dashboard_cleanup_attempts ADD CONSTRAINT dashboard_cleanup_attempts_result_check CHECK ((result = ANY (ARRAY['succeeded'::text, 'retryable_failure'::text, 'held'::text, 'outstanding_reference'::text, 'already_complete'::text])));
ALTER TABLE dasher.dashboard_cleanup_attempts ADD CONSTRAINT dashboard_cleanup_attempts_outcome_check CHECK (((finished_at IS NULL OR finished_at >= started_at) AND (released_claim_count >= 0) AND (deleted_resource_count >= 0) AND (deferred_claim_count >= 0) AND ((result = 'retryable_failure'::text) = (failure_code IS NOT NULL))));
ALTER TABLE dasher.dashboard_legal_holds ADD CONSTRAINT dashboard_legal_holds_release_check CHECK ((((released_at IS NULL) AND (released_by_principal_id IS NULL) AND (released_authority_revision IS NULL) AND (released_actor IS NULL) AND (released_reason_sha256 IS NULL)) OR ((released_at IS NOT NULL) AND (released_by_principal_id IS NOT NULL) AND (released_authority_revision IS NOT NULL) AND (released_actor IS NOT NULL) AND (released_reason_sha256 IS NOT NULL) AND (released_at >= placed_at))));
ALTER TABLE dasher.dashboard_tombstones ADD CONSTRAINT dashboard_tombstones_purge_check CHECK ((((purged_at IS NULL) AND (purged_lifecycle_revision IS NULL) AND (purged_proof_sha256 IS NULL)) OR ((purged_at IS NOT NULL) AND (purged_lifecycle_revision IS NOT NULL) AND (purged_proof_sha256 IS NOT NULL) AND (purged_at >= access_revoked_at) AND (purged_lifecycle_revision > access_revoked_lifecycle_revision))));
ALTER TABLE dasher.backup_deletion_ledger ADD CONSTRAINT backup_deletion_ledger_event_kind_check CHECK ((event_kind = ANY (ARRAY['access_revoked'::text, 'purged'::text])));
ALTER TABLE dasher.dashboard_promotion_decisions ADD CONSTRAINT dashboard_promotion_decisions_decision_check CHECK ((decision = ANY (ARRAY['approved'::text, 'denied'::text])));
ALTER TABLE dasher.dashboard_promotion_decisions ADD CONSTRAINT dashboard_promotion_decisions_requester_approver_check CHECK ((requested_by_user_id <> decided_by_user_id));
ALTER TABLE dasher.retention_service_principal_allowlist ADD CONSTRAINT retention_allowlist_binding_kind_check CHECK ((binding_kind = 'postgres_session_user'::text));
ALTER TABLE dasher.retention_service_principal_allowlist ADD CONSTRAINT retention_allowlist_authority_scope_check CHECK ((authority_scope = ANY (ARRAY['platform_operator'::text, 'tenant_legal_admin'::text])));
ALTER TABLE dasher.retention_service_principal_allowlist ADD CONSTRAINT retention_allowlist_scope_check CHECK ((((authority_scope = 'platform_operator'::text) AND (scope_organization_id IS NULL)) OR ((authority_scope = 'tenant_legal_admin'::text) AND (scope_organization_id IS NOT NULL))));
ALTER TABLE dasher.retention_service_principal_allowlist ADD CONSTRAINT retention_allowlist_predecessor_check CHECK (((principal_revision = 1) = ((predecessor_revision IS NULL) AND (predecessor_sha256 IS NULL))));
ALTER TABLE dasher.source_snapshots ADD CONSTRAINT source_snapshots_source_kind_check CHECK ((source_kind = ANY (ARRAY['synthetic_fixture'::text, 'public_usgs_fixture'::text])));
ALTER TABLE dasher.source_snapshots ADD CONSTRAINT source_snapshots_canonical_bytes_length_check CHECK (((octet_length(canonical_bytes) >= 1) AND (octet_length(canonical_bytes) <= 1048576)));
ALTER TABLE dasher.evidence_records ADD CONSTRAINT evidence_records_evidence_kind_check CHECK ((evidence_kind = ANY (ARRAY['source_record'::text, 'typed_value'::text, 'calculation_result'::text, 'event_record'::text])));
ALTER TABLE dasher.dashboard_versions ADD CONSTRAINT dashboard_versions_validation_state_check CHECK ((validation_state = 'validated'::text));
ALTER TABLE dasher.dashboard_versions ADD CONSTRAINT dashboard_versions_canonical_spec_bytes_length_check CHECK (((octet_length(canonical_spec_bytes) >= 2) AND (octet_length(canonical_spec_bytes) <= 1048576)));
ALTER TABLE dasher.dashboard_versions ADD CONSTRAINT dashboard_versions_canonical_spec_sha256_bytes_check CHECK ((canonical_spec_sha256 = sha256(canonical_spec_bytes)));
ALTER TABLE dasher.dashboard_artifacts ADD CONSTRAINT dashboard_artifacts_ownership_class_check CHECK ((ownership_class = ANY (ARRAY['dashboard_owned'::text, 'shared'::text])));
ALTER TABLE dasher.snapshot_reference_claims ADD CONSTRAINT snapshot_reference_claims_claim_kind_check CHECK ((claim_kind = ANY (ARRAY['access_bearing'::text, 'retention_only'::text])));
ALTER TABLE dasher.snapshot_reference_claims ADD CONSTRAINT snapshot_reference_claims_hold_check CHECK ((((claim_kind = 'access_bearing'::text) AND (hold_id IS NULL)) OR ((claim_kind = 'retention_only'::text) AND (hold_id IS NOT NULL))));
ALTER TABLE dasher.evidence_reference_claims ADD CONSTRAINT evidence_reference_claims_claim_kind_check CHECK ((claim_kind = ANY (ARRAY['access_bearing'::text, 'retention_only'::text])));
ALTER TABLE dasher.evidence_reference_claims ADD CONSTRAINT evidence_reference_claims_hold_check CHECK ((((claim_kind = 'access_bearing'::text) AND (hold_id IS NULL)) OR ((claim_kind = 'retention_only'::text) AND (hold_id IS NOT NULL))));
ALTER TABLE dasher.artifact_reference_claims ADD CONSTRAINT artifact_reference_claims_claim_kind_check CHECK ((claim_kind = ANY (ARRAY['access_bearing'::text, 'retention_only'::text])));
ALTER TABLE dasher.artifact_reference_claims ADD CONSTRAINT artifact_reference_claims_hold_check CHECK ((((claim_kind = 'access_bearing'::text) AND (hold_id IS NULL)) OR ((claim_kind = 'retention_only'::text) AND (hold_id IS NOT NULL))));
ALTER TABLE dasher.snapshot_deletion_finalizers ADD CONSTRAINT snapshot_deletion_finalizers_state_check CHECK ((state = ANY (ARRAY['intent'::text, 'eligible'::text, 'deleted'::text])));
ALTER TABLE dasher.snapshot_deletion_finalizers ADD CONSTRAINT snapshot_deletion_finalizers_completion_check CHECK ((((lease_owner IS NULL) = (lease_expires_at IS NULL)) AND (((state = 'intent'::text) AND (proof_sha256 IS NULL) AND (bytes_deleted_at IS NULL)) OR ((state = 'eligible'::text) AND (proof_sha256 = expected_claim_set_sha256) AND (bytes_deleted_at IS NULL)) OR ((state = 'deleted'::text) AND (lease_owner IS NULL) AND (proof_sha256 = expected_claim_set_sha256) AND (bytes_deleted_at IS NOT NULL) AND (bytes_deleted_at >= intent_at)))));
ALTER TABLE dasher.evidence_deletion_finalizers ADD CONSTRAINT evidence_deletion_finalizers_state_check CHECK ((state = ANY (ARRAY['intent'::text, 'eligible'::text, 'deleted'::text])));
ALTER TABLE dasher.evidence_deletion_finalizers ADD CONSTRAINT evidence_deletion_finalizers_completion_check CHECK ((((lease_owner IS NULL) = (lease_expires_at IS NULL)) AND (((state = 'intent'::text) AND (proof_sha256 IS NULL) AND (bytes_deleted_at IS NULL)) OR ((state = 'eligible'::text) AND (proof_sha256 = expected_claim_set_sha256) AND (bytes_deleted_at IS NULL)) OR ((state = 'deleted'::text) AND (lease_owner IS NULL) AND (proof_sha256 = expected_claim_set_sha256) AND (bytes_deleted_at IS NOT NULL) AND (bytes_deleted_at >= intent_at)))));
ALTER TABLE dasher.artifact_deletion_finalizers ADD CONSTRAINT artifact_deletion_finalizers_state_check CHECK ((state = ANY (ARRAY['intent'::text, 'eligible'::text, 'deleted'::text])));
ALTER TABLE dasher.artifact_deletion_finalizers ADD CONSTRAINT artifact_deletion_finalizers_completion_check CHECK ((((lease_owner IS NULL) = (lease_expires_at IS NULL)) AND (((state = 'intent'::text) AND (proof_sha256 IS NULL) AND (bytes_deleted_at IS NULL)) OR ((state = 'eligible'::text) AND (proof_sha256 = expected_claim_set_sha256) AND (bytes_deleted_at IS NULL)) OR ((state = 'deleted'::text) AND (lease_owner IS NULL) AND (proof_sha256 = expected_claim_set_sha256) AND (bytes_deleted_at IS NOT NULL) AND (bytes_deleted_at >= intent_at)))));

CREATE UNIQUE INDEX dashboards_organization_tombstone_lineage_uidx ON dasher.dashboards USING btree (organization_id, tombstone_lineage_id);
CREATE INDEX dashboard_lifecycle_policies_organization_fk_idx ON dasher.dashboard_lifecycle_policies USING btree (organization_id);
CREATE INDEX dashboards_organization_fk_idx ON dasher.dashboards USING btree (organization_id);
CREATE INDEX dashboards_creator_fk_idx ON dasher.dashboards USING btree (created_by_user_id);
CREATE INDEX dashboards_head_version_fk_idx ON dasher.dashboards USING btree (organization_id, dashboard_id, head_version_id);
CREATE INDEX dashboards_restore_tombstone_fk_idx ON dasher.dashboards USING btree (organization_id, restored_from_tombstone_lineage_id);
CREATE INDEX dashboard_lifecycle_events_dashboard_fk_idx ON dasher.dashboard_lifecycle_events USING btree (organization_id, dashboard_id);
CREATE INDEX dashboard_promotion_requests_dashboard_fk_idx ON dasher.dashboard_promotion_requests USING btree (organization_id, dashboard_id);
CREATE INDEX dashboard_promotion_decisions_request_fk_idx ON dasher.dashboard_promotion_decisions USING btree (organization_id, promotion_request_id);
CREATE INDEX dashboard_cleanup_coordination_dashboard_fk_idx ON dasher.dashboard_cleanup_coordination USING btree (organization_id, dashboard_id);
CREATE INDEX dashboard_cleanup_attempts_dashboard_fk_idx ON dasher.dashboard_cleanup_attempts USING btree (organization_id, dashboard_id);
CREATE INDEX dashboard_legal_holds_dashboard_fk_idx ON dasher.dashboard_legal_holds USING btree (organization_id, dashboard_id);
CREATE INDEX dashboard_restore_lineage_dashboard_version_fk_idx ON dasher.dashboard_restore_lineage USING btree (organization_id, dashboard_id, version_id);
CREATE INDEX dashboard_restore_lineage_tombstone_fk_idx ON dasher.dashboard_restore_lineage USING btree (organization_id, source_tombstone_lineage_id);
CREATE INDEX backup_deletion_ledger_tombstone_fk_idx ON dasher.backup_deletion_ledger USING btree (organization_id, tombstone_lineage_id);
CREATE INDEX retention_allowlist_scope_organization_fk_idx ON dasher.retention_service_principal_allowlist USING btree (scope_organization_id);
CREATE INDEX source_snapshots_organization_fk_idx ON dasher.source_snapshots USING btree (organization_id);
CREATE INDEX evidence_records_snapshot_fk_idx ON dasher.evidence_records USING btree (organization_id, snapshot_id);
CREATE INDEX dashboard_versions_dashboard_fk_idx ON dasher.dashboard_versions USING btree (organization_id, dashboard_id);
CREATE INDEX dashboard_versions_parent_fk_idx ON dasher.dashboard_versions USING btree (organization_id, dashboard_id, parent_version_id);
CREATE INDEX dashboard_version_snapshots_version_fk_idx ON dasher.dashboard_version_snapshots USING btree (organization_id, dashboard_id, version_id);
CREATE INDEX dashboard_version_snapshots_snapshot_fk_idx ON dasher.dashboard_version_snapshots USING btree (organization_id, snapshot_id);
CREATE INDEX dashboard_version_evidence_version_fk_idx ON dasher.dashboard_version_evidence USING btree (organization_id, dashboard_id, version_id);
CREATE INDEX dashboard_version_evidence_evidence_fk_idx ON dasher.dashboard_version_evidence USING btree (organization_id, evidence_id);
CREATE INDEX dashboard_artifacts_version_fk_idx ON dasher.dashboard_artifacts USING btree (organization_id, dashboard_id, version_id);
CREATE INDEX snapshot_reference_claims_snapshot_fk_idx ON dasher.snapshot_reference_claims USING btree (organization_id, snapshot_id);
CREATE INDEX snapshot_reference_claims_version_fk_idx ON dasher.snapshot_reference_claims USING btree (organization_id, dashboard_id, version_id);
CREATE INDEX snapshot_reference_claims_hold_fk_idx ON dasher.snapshot_reference_claims USING btree (organization_id, dashboard_id, hold_id);
CREATE INDEX evidence_reference_claims_evidence_fk_idx ON dasher.evidence_reference_claims USING btree (organization_id, evidence_id);
CREATE INDEX evidence_reference_claims_version_fk_idx ON dasher.evidence_reference_claims USING btree (organization_id, dashboard_id, version_id);
CREATE INDEX evidence_reference_claims_hold_fk_idx ON dasher.evidence_reference_claims USING btree (organization_id, dashboard_id, hold_id);
CREATE INDEX artifact_reference_claims_artifact_fk_idx ON dasher.artifact_reference_claims USING btree (organization_id, artifact_id);
CREATE INDEX artifact_reference_claims_version_fk_idx ON dasher.artifact_reference_claims USING btree (organization_id, dashboard_id, version_id);
CREATE INDEX artifact_reference_claims_hold_fk_idx ON dasher.artifact_reference_claims USING btree (organization_id, dashboard_id, hold_id);
CREATE INDEX snapshot_deletion_finalizers_snapshot_fk_idx ON dasher.snapshot_deletion_finalizers USING btree (organization_id, snapshot_id);
CREATE INDEX evidence_deletion_finalizers_evidence_fk_idx ON dasher.evidence_deletion_finalizers USING btree (organization_id, evidence_id);
CREATE INDEX artifact_deletion_finalizers_artifact_fk_idx ON dasher.artifact_deletion_finalizers USING btree (organization_id, artifact_id);
CREATE INDEX dashboards_effective_expiry_idx ON dasher.dashboards USING btree (effective_expires_at, organization_id, dashboard_id) WHERE ((current_kind = 'disposable'::text) AND (access_revoked_at IS NULL) AND (purged_at IS NULL));
CREATE INDEX dashboards_purge_after_idx ON dasher.dashboards USING btree (purge_after, organization_id, dashboard_id) WHERE ((purged_at IS NULL) AND (purge_after IS NOT NULL));
CREATE INDEX dashboard_cleanup_coordination_next_attempt_idx ON dasher.dashboard_cleanup_coordination USING btree (next_attempt_at, organization_id, dashboard_id);
CREATE INDEX dashboard_legal_holds_active_idx ON dasher.dashboard_legal_holds USING btree (organization_id, dashboard_id, hold_id) WHERE released_at IS NULL;

ALTER TABLE dasher.dashboard_lifecycle_policies ADD CONSTRAINT dashboard_lifecycle_policies_organization_fk FOREIGN KEY (organization_id) REFERENCES dasher.organizations(organization_id);
ALTER TABLE dasher.dashboards ADD CONSTRAINT dashboards_organization_fk FOREIGN KEY (organization_id) REFERENCES dasher.organizations(organization_id);
ALTER TABLE dasher.dashboards ADD CONSTRAINT dashboards_creator_fk FOREIGN KEY (created_by_user_id) REFERENCES dasher.users(user_id);
ALTER TABLE dasher.dashboards ADD CONSTRAINT dashboards_head_version_fk FOREIGN KEY (organization_id, dashboard_id, head_version_id) REFERENCES dasher.dashboard_versions(organization_id, dashboard_id, version_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE dasher.dashboards ADD CONSTRAINT dashboards_restore_tombstone_fk FOREIGN KEY (organization_id, restored_from_tombstone_lineage_id) REFERENCES dasher.dashboard_tombstones(organization_id, tombstone_lineage_id);
ALTER TABLE dasher.dashboard_lifecycle_events ADD CONSTRAINT dashboard_lifecycle_events_dashboard_fk FOREIGN KEY (organization_id, dashboard_id) REFERENCES dasher.dashboards(organization_id, dashboard_id);
ALTER TABLE dasher.dashboard_promotion_requests ADD CONSTRAINT dashboard_promotion_requests_dashboard_fk FOREIGN KEY (organization_id, dashboard_id) REFERENCES dasher.dashboards(organization_id, dashboard_id);
ALTER TABLE dasher.dashboard_promotion_decisions ADD CONSTRAINT dashboard_promotion_decisions_request_fk FOREIGN KEY (organization_id, promotion_request_id) REFERENCES dasher.dashboard_promotion_requests(organization_id, promotion_request_id);
ALTER TABLE dasher.dashboard_cleanup_coordination ADD CONSTRAINT dashboard_cleanup_coordination_dashboard_fk FOREIGN KEY (organization_id, dashboard_id) REFERENCES dasher.dashboards(organization_id, dashboard_id);
ALTER TABLE dasher.dashboard_cleanup_attempts ADD CONSTRAINT dashboard_cleanup_attempts_dashboard_fk FOREIGN KEY (organization_id, dashboard_id) REFERENCES dasher.dashboards(organization_id, dashboard_id);
ALTER TABLE dasher.dashboard_legal_holds ADD CONSTRAINT dashboard_legal_holds_dashboard_fk FOREIGN KEY (organization_id, dashboard_id) REFERENCES dasher.dashboards(organization_id, dashboard_id);
ALTER TABLE dasher.dashboard_restore_lineage ADD CONSTRAINT dashboard_restore_lineage_dashboard_version_fk FOREIGN KEY (organization_id, dashboard_id, version_id) REFERENCES dasher.dashboard_versions(organization_id, dashboard_id, version_id);
ALTER TABLE dasher.dashboard_restore_lineage ADD CONSTRAINT dashboard_restore_lineage_tombstone_fk FOREIGN KEY (organization_id, source_tombstone_lineage_id) REFERENCES dasher.dashboard_tombstones(organization_id, tombstone_lineage_id);
ALTER TABLE dasher.backup_deletion_ledger ADD CONSTRAINT backup_deletion_ledger_tombstone_fk FOREIGN KEY (organization_id, tombstone_lineage_id) REFERENCES dasher.dashboard_tombstones(organization_id, tombstone_lineage_id);
ALTER TABLE dasher.retention_service_principal_allowlist ADD CONSTRAINT retention_allowlist_scope_organization_fk FOREIGN KEY (scope_organization_id) REFERENCES dasher.organizations(organization_id);
ALTER TABLE dasher.source_snapshots ADD CONSTRAINT source_snapshots_organization_fk FOREIGN KEY (organization_id) REFERENCES dasher.organizations(organization_id);
ALTER TABLE dasher.evidence_records ADD CONSTRAINT evidence_records_snapshot_fk FOREIGN KEY (organization_id, snapshot_id) REFERENCES dasher.source_snapshots(organization_id, snapshot_id);
ALTER TABLE dasher.dashboard_versions ADD CONSTRAINT dashboard_versions_dashboard_fk FOREIGN KEY (organization_id, dashboard_id) REFERENCES dasher.dashboards(organization_id, dashboard_id);
ALTER TABLE dasher.dashboard_versions ADD CONSTRAINT dashboard_versions_parent_fk FOREIGN KEY (organization_id, dashboard_id, parent_version_id) REFERENCES dasher.dashboard_versions(organization_id, dashboard_id, version_id);
ALTER TABLE dasher.dashboard_version_snapshots ADD CONSTRAINT dashboard_version_snapshots_version_fk FOREIGN KEY (organization_id, dashboard_id, version_id) REFERENCES dasher.dashboard_versions(organization_id, dashboard_id, version_id);
ALTER TABLE dasher.dashboard_version_snapshots ADD CONSTRAINT dashboard_version_snapshots_snapshot_fk FOREIGN KEY (organization_id, snapshot_id) REFERENCES dasher.source_snapshots(organization_id, snapshot_id);
ALTER TABLE dasher.dashboard_version_evidence ADD CONSTRAINT dashboard_version_evidence_version_fk FOREIGN KEY (organization_id, dashboard_id, version_id) REFERENCES dasher.dashboard_versions(organization_id, dashboard_id, version_id);
ALTER TABLE dasher.dashboard_version_evidence ADD CONSTRAINT dashboard_version_evidence_evidence_fk FOREIGN KEY (organization_id, evidence_id) REFERENCES dasher.evidence_records(organization_id, evidence_id);
ALTER TABLE dasher.snapshot_reference_claims ADD CONSTRAINT snapshot_reference_claims_snapshot_fk FOREIGN KEY (organization_id, snapshot_id) REFERENCES dasher.source_snapshots(organization_id, snapshot_id);
ALTER TABLE dasher.snapshot_reference_claims ADD CONSTRAINT snapshot_reference_claims_version_fk FOREIGN KEY (organization_id, dashboard_id, version_id) REFERENCES dasher.dashboard_versions(organization_id, dashboard_id, version_id);
ALTER TABLE dasher.snapshot_reference_claims ADD CONSTRAINT snapshot_reference_claims_hold_fk FOREIGN KEY (organization_id, dashboard_id, hold_id) REFERENCES dasher.dashboard_legal_holds(organization_id, dashboard_id, hold_id);
ALTER TABLE dasher.evidence_reference_claims ADD CONSTRAINT evidence_reference_claims_evidence_fk FOREIGN KEY (organization_id, evidence_id) REFERENCES dasher.evidence_records(organization_id, evidence_id);
ALTER TABLE dasher.evidence_reference_claims ADD CONSTRAINT evidence_reference_claims_version_fk FOREIGN KEY (organization_id, dashboard_id, version_id) REFERENCES dasher.dashboard_versions(organization_id, dashboard_id, version_id);
ALTER TABLE dasher.evidence_reference_claims ADD CONSTRAINT evidence_reference_claims_hold_fk FOREIGN KEY (organization_id, dashboard_id, hold_id) REFERENCES dasher.dashboard_legal_holds(organization_id, dashboard_id, hold_id);
ALTER TABLE dasher.artifact_reference_claims ADD CONSTRAINT artifact_reference_claims_artifact_fk FOREIGN KEY (organization_id, artifact_id) REFERENCES dasher.dashboard_artifacts(organization_id, artifact_id);
ALTER TABLE dasher.artifact_reference_claims ADD CONSTRAINT artifact_reference_claims_version_fk FOREIGN KEY (organization_id, dashboard_id, version_id) REFERENCES dasher.dashboard_versions(organization_id, dashboard_id, version_id);
ALTER TABLE dasher.artifact_reference_claims ADD CONSTRAINT artifact_reference_claims_hold_fk FOREIGN KEY (organization_id, dashboard_id, hold_id) REFERENCES dasher.dashboard_legal_holds(organization_id, dashboard_id, hold_id);

ALTER TABLE dasher.dashboard_lifecycle_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE dasher.dashboard_lifecycle_policies FORCE ROW LEVEL SECURITY;
ALTER TABLE dasher.dashboards ENABLE ROW LEVEL SECURITY;
ALTER TABLE dasher.dashboards FORCE ROW LEVEL SECURITY;
ALTER TABLE dasher.dashboard_lifecycle_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE dasher.dashboard_lifecycle_events FORCE ROW LEVEL SECURITY;
ALTER TABLE dasher.dashboard_promotion_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE dasher.dashboard_promotion_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE dasher.dashboard_promotion_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE dasher.dashboard_promotion_decisions FORCE ROW LEVEL SECURITY;
ALTER TABLE dasher.dashboard_cleanup_coordination ENABLE ROW LEVEL SECURITY;
ALTER TABLE dasher.dashboard_cleanup_coordination FORCE ROW LEVEL SECURITY;
ALTER TABLE dasher.dashboard_cleanup_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE dasher.dashboard_cleanup_attempts FORCE ROW LEVEL SECURITY;
ALTER TABLE dasher.dashboard_legal_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE dasher.dashboard_legal_holds FORCE ROW LEVEL SECURITY;
ALTER TABLE dasher.dashboard_tombstones ENABLE ROW LEVEL SECURITY;
ALTER TABLE dasher.dashboard_tombstones FORCE ROW LEVEL SECURITY;
ALTER TABLE dasher.dashboard_restore_lineage ENABLE ROW LEVEL SECURITY;
ALTER TABLE dasher.dashboard_restore_lineage FORCE ROW LEVEL SECURITY;
ALTER TABLE dasher.backup_deletion_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE dasher.backup_deletion_ledger FORCE ROW LEVEL SECURITY;
ALTER TABLE dasher.retention_service_principal_allowlist ENABLE ROW LEVEL SECURITY;
ALTER TABLE dasher.retention_service_principal_allowlist FORCE ROW LEVEL SECURITY;
ALTER TABLE dasher.source_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE dasher.source_snapshots FORCE ROW LEVEL SECURITY;
ALTER TABLE dasher.evidence_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE dasher.evidence_records FORCE ROW LEVEL SECURITY;
ALTER TABLE dasher.dashboard_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE dasher.dashboard_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE dasher.dashboard_version_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE dasher.dashboard_version_snapshots FORCE ROW LEVEL SECURITY;
ALTER TABLE dasher.dashboard_version_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE dasher.dashboard_version_evidence FORCE ROW LEVEL SECURITY;
ALTER TABLE dasher.dashboard_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE dasher.dashboard_artifacts FORCE ROW LEVEL SECURITY;
ALTER TABLE dasher.snapshot_reference_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE dasher.snapshot_reference_claims FORCE ROW LEVEL SECURITY;
ALTER TABLE dasher.evidence_reference_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE dasher.evidence_reference_claims FORCE ROW LEVEL SECURITY;
ALTER TABLE dasher.artifact_reference_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE dasher.artifact_reference_claims FORCE ROW LEVEL SECURITY;
ALTER TABLE dasher.snapshot_deletion_finalizers ENABLE ROW LEVEL SECURITY;
ALTER TABLE dasher.snapshot_deletion_finalizers FORCE ROW LEVEL SECURITY;
ALTER TABLE dasher.evidence_deletion_finalizers ENABLE ROW LEVEL SECURITY;
ALTER TABLE dasher.evidence_deletion_finalizers FORCE ROW LEVEL SECURITY;
ALTER TABLE dasher.artifact_deletion_finalizers ENABLE ROW LEVEL SECURITY;
ALTER TABLE dasher.artifact_deletion_finalizers FORCE ROW LEVEL SECURITY;

CREATE FUNCTION dasher_api.list_dashboards(integer)
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
  IF $1 IS NULL OR $1 NOT BETWEEN 1 AND 100 OR v_organization_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  RETURN QUERY
    SELECT ROW(dashboard_id, title, current_kind, lifecycle_state,
      lifecycle_revision, effective_expires_at, head_version_id
    )::dasher.dashboard_summary
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

CREATE FUNCTION dasher_api.get_dashboard_summary(uuid)
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
  SELECT ROW(dashboard_id, title, current_kind, lifecycle_state,
      lifecycle_revision, effective_expires_at, head_version_id
    )::dasher.dashboard_summary
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
  IF v_result IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  RETURN v_result;
END
$function$;

CREATE FUNCTION dasher_api.get_dashboard_head(uuid)
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
  SELECT ROW(version.dashboard_id, version.version_id, version.parent_version_id,
      version.canonical_spec_bytes, version.canonical_spec_sha256,
      version.validation_state, version.validation_sha256,
      version.planner_provenance_sha256, version.policy_revision,
      version.registry_revision, version.calculation_graph_sha256,
      version.created_at)::dasher.dashboard_version_projection
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
  IF v_result IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  RETURN v_result;
END
$function$;

CREATE FUNCTION dasher_api.get_dashboard_version(uuid, uuid)
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
  SELECT ROW(version.dashboard_id, version.version_id, version.parent_version_id,
      version.canonical_spec_bytes, version.canonical_spec_sha256,
      version.validation_state,
      version.validation_sha256, version.planner_provenance_sha256,
      version.policy_revision, version.registry_revision,
      version.calculation_graph_sha256, version.created_at
    )::dasher.dashboard_version_projection
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
  IF v_result IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  RETURN v_result;
END
$function$;

CREATE FUNCTION dasher_api.get_dashboard_evidence(uuid, uuid)
RETURNS SETOF dasher.dashboard_evidence_projection
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_now timestamptz := statement_timestamp();
BEGIN
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
    SELECT ROW(link.dashboard_id, link.version_id, evidence.evidence_id,
      evidence.evidence_kind, evidence.content_sha256, evidence.observed_at,
      evidence.retrieved_at)::dasher.dashboard_evidence_projection
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

CREATE FUNCTION dasher_api.get_dashboard_lineage(uuid, uuid)
RETURNS SETOF dasher.dashboard_lineage_projection
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_now timestamptz := statement_timestamp();
BEGIN
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
          AND missing_artifact.dashboard_id = version.dashboard_id
          AND missing_artifact.version_id = version.version_id
          AND NOT EXISTS (
            SELECT 1 FROM dasher.artifact_reference_claims AS claim
            WHERE claim.organization_id = missing_artifact.organization_id
              AND claim.artifact_id = missing_artifact.artifact_id
              AND claim.dashboard_id = missing_artifact.dashboard_id
              AND claim.version_id = missing_artifact.version_id
              AND claim.claim_kind = 'access_bearing' AND claim.hold_id IS NULL
          )
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  RETURN QUERY
    SELECT ROW(version.dashboard_id, version.version_id, version.parent_version_id,
      snapshot.snapshot_id, evidence.evidence_id, artifact.artifact_id
    )::dasher.dashboard_lineage_projection
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
     AND artifact.dashboard_id = version.dashboard_id
     AND artifact.version_id = version.version_id
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
          AND missing_artifact.dashboard_id = version.dashboard_id
          AND missing_artifact.version_id = version.version_id
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

CREATE FUNCTION dasher_api.get_dashboard_admin_status(uuid)
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
  SELECT ROW(dashboard.dashboard_id, dashboard.lifecycle_state,
      dashboard.lifecycle_revision, dashboard.capability_epoch,
      dashboard.cache_epoch, dashboard.access_revoked_at, dashboard.purge_after,
      dashboard.purge_started_at, dashboard.purged_at,
      (SELECT count(*) FROM dasher.dashboard_legal_holds AS hold
       WHERE hold.organization_id = dashboard.organization_id
         AND hold.dashboard_id = dashboard.dashboard_id
         AND hold.released_at IS NULL),
      coordination.current_step)::dasher.dashboard_admin_projection
    INTO v_result
  FROM dasher.dashboards AS dashboard
  LEFT JOIN dasher.dashboard_cleanup_coordination AS coordination
    ON coordination.organization_id = dashboard.organization_id
   AND coordination.dashboard_id = dashboard.dashboard_id
  WHERE dashboard.organization_id = dasher_private.context_organization_id()
    AND dashboard.dashboard_id = $1;
  IF v_result IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  RETURN v_result;
END
$function$;

CREATE FUNCTION dasher_api.create_dashboard(uuid, text, text, integer, boolean, uuid, uuid, text)
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
  v_default_ttl_seconds integer;
  v_ttl_seconds integer;
  v_policy_row_revision bigint;
  v_policy_revision bigint;
BEGIN
  IF NOT dasher_private.context_allows(v_organization_id, 'editor') THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  IF v_organization_id IS NULL OR v_actor_user_id IS NULL OR $1 IS NULL
    OR $2 IS NULL OR btrim($2) <> $2 OR char_length($2) NOT BETWEEN 1 AND 200
    OR $3 NOT IN ('disposable', 'durable') OR $5 IS NULL
    OR ($3 = 'disposable' AND (($5 AND $4 IS NOT NULL)
      OR (NOT $5 AND $4 NOT IN (3600, 86400, 604800, 2592000))))
    OR ($3 = 'durable' AND ($4 IS NOT NULL OR $5)) OR $6 IS NULL OR $7 IS NULL
    OR $8 IS NULL OR char_length($8) NOT BETWEEN 1 AND 64
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
  INSERT INTO dasher.dashboards (
    organization_id, dashboard_id, title, created_by_user_id, created_at,
    created_kind, current_kind, original_expires_at, effective_expires_at,
    lifecycle_state, lifecycle_revision, capability_epoch, cache_epoch,
    retention_policy_revision, tombstone_lineage_id
  ) VALUES (
    v_organization_id, $1, $2, v_actor_user_id, v_now, $3, $3,
    CASE WHEN $3 = 'disposable' THEN v_now + make_interval(secs => v_ttl_seconds) END,
    CASE WHEN $3 = 'disposable' THEN v_now + make_interval(secs => v_ttl_seconds) END,
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
    NULL, NULL, NULL, $8
  );
  RETURN $1;
END
$function$;

CREATE FUNCTION dasher_api.create_evidence_record(uuid, uuid, uuid, uuid, uuid, text, text, bytea, timestamptz, timestamptz, uuid, text)
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
BEGIN
  IF NOT dasher_private.context_allows(v_organization_id, 'editor') THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  IF v_organization_id IS NULL OR v_actor_user_id IS NULL OR $1 IS NULL
    OR $2 IS NULL OR $3 IS NULL OR $4 IS NULL OR $5 IS NULL OR $6 NOT IN (
      'source_record', 'typed_value', 'calculation_result', 'event_record'
    ) OR $7 IS NULL OR btrim($7) <> $7 OR char_length($7) NOT BETWEEN 1 AND 200
    OR $8 IS NULL OR octet_length($8) <> 32 OR $9 IS NULL OR $10 IS NULL
    OR $9 > $10 OR $11 IS NULL OR $11 = dasher_private.context_request_id()
    OR $12 IS NULL OR char_length($12) NOT BETWEEN 1 AND 64
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
        AND dashboard.lifecycle_state IN ('draft', 'active', 'archived')
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
        AND dashboard.lifecycle_state IN ('draft', 'active', 'archived')
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
    NULL, NULL, NULL, NULL, NULL, $12
  );
END
$function$;

CREATE FUNCTION dasher_api.create_dashboard_version(uuid, uuid, uuid, bytea, bytea, bytea, bytea, bigint, bigint, bytea, uuid[], uuid[], uuid[], uuid[], uuid, text)
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
BEGIN
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
    OR $16 IS NULL OR char_length($16) NOT BETWEEN 1 AND 64
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
    NULL, NULL, NULL, NULL, NULL, $16
  );
  RETURN $2;
END
$function$;

CREATE FUNCTION dasher_api.compare_and_swap_dashboard_head(uuid, uuid, uuid, bigint, uuid, text)
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
BEGIN
  IF NOT dasher_private.context_allows(v_organization_id, 'editor') THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  IF v_organization_id IS NULL OR $1 IS NULL OR $3 IS NULL OR $4 IS NULL
    OR $4 < 0 OR $5 IS NULL OR $6 IS NULL
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
    NULL, NULL, NULL, NULL, NULL, $6
  );
END
$function$;

CREATE FUNCTION dasher_api.request_dashboard_promotion(uuid, uuid, bigint, bytea, uuid, text)
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
BEGIN
  IF NOT dasher_private.context_allows(v_organization_id, 'editor')
    OR v_actor_user_id IS NULL OR $1 IS NULL
    OR $2 IS NULL OR $3 < 0 OR $4 IS NULL OR octet_length($4) <> 32
    OR $5 IS NULL OR $5 = dasher_private.context_request_id() OR $6 IS NULL
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
    NULL, NULL, NULL, NULL, NULL, $6
  );
  RETURN $2;
END
$function$;

CREATE FUNCTION dasher_api.decide_dashboard_promotion(uuid, bigint, text, uuid, uuid, text)
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
BEGIN
  IF NOT dasher_private.context_allows(v_organization_id, 'admin')
    OR v_actor_user_id IS NULL OR $1 IS NULL OR $2 < 0
    OR $3 NOT IN ('approved', 'denied')
    OR ($3 = 'approved' AND $4 IS NULL) OR ($3 = 'denied' AND $4 IS NOT NULL)
    OR $5 IS NULL OR $5 = dasher_private.context_request_id() OR $6 IS NULL
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
    'succeeded', v_rationale_sha256, NULL, NULL, NULL, NULL, NULL, $6
  );
END
$function$;

CREATE FUNCTION dasher_api.set_dashboard_archive(uuid, boolean, bigint, uuid, text)
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
BEGIN
  IF NOT dasher_private.context_allows(v_organization_id, 'admin') THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  IF v_organization_id IS NULL OR $1 IS NULL OR $2 IS NULL OR $3 < 0
    OR $4 IS NULL OR $5 IS NULL THEN
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
    NULL, NULL, NULL, NULL, NULL, $5
  );
END
$function$;

CREATE FUNCTION dasher_api.delete_dashboard(uuid, bigint, uuid, text)
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
BEGIN
  IF NOT dasher_private.context_allows(v_organization_id, 'admin') THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  IF v_organization_id IS NULL OR $1 IS NULL OR $2 < 0 OR $3 IS NULL
    OR $4 IS NULL THEN
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
    NULL, NULL, NULL, NULL, NULL, $4
  );
END
$function$;

CREATE FUNCTION dasher_api.restore_dashboard_as_new(uuid, uuid, bigint, uuid, uuid, uuid, text, bytea, uuid, text)
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
BEGIN
  IF NOT dasher_private.context_allows(v_organization_id, 'admin')
    OR v_actor_user_id IS NULL OR $1 IS NULL OR $2 IS NULL OR $3 < 0
    OR $4 IS NULL OR $5 IS NULL OR $6 IS NULL OR $7 IS NULL
    OR btrim($7) <> $7 OR char_length($7) NOT BETWEEN 1 AND 200
    OR $8 IS NULL OR octet_length($8) <> 32 OR $9 IS NULL
    OR $9 = dasher_private.context_request_id()
    OR $10 IS NULL OR char_length($10) NOT BETWEEN 1 AND 64
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
    NULL, NULL, NULL, NULL, NULL, $10
  );
END
$function$;

CREATE FUNCTION dasher_retention_api.initialize_operator_context(uuid, text, uuid, text, uuid)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_binding_gate bigint;
  v_organization_gate bigint;
  v_principal_id uuid;
  v_principal_revision bigint;
  v_authority_scope text;
  v_scope_organization_id uuid;
  v_enabled boolean;
  v_can_initialize boolean;
  v_capability_allowed boolean;
  v_target_organization_id uuid;
  v_chain_count bigint;
  v_chain_min_revision bigint;
  v_chain_valid boolean;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  IF COALESCE(current_setting('dasher.retention_phase', true), '') <> ''
    OR COALESCE(current_setting('dasher.retention_principal_id', true), '') <> ''
    OR COALESCE(current_setting('dasher.retention_principal_revision', true), '') <> ''
    OR COALESCE(current_setting('dasher.retention_authority_scope', true), '') <> ''
    OR COALESCE(current_setting('dasher.retention_capability', true), '') <> ''
    OR COALESCE(current_setting('dasher.retention_target_dashboard_id', true), '') <> ''
    OR COALESCE(current_setting('dasher.retention_target_organization_id', true), '') <> ''
    OR COALESCE(current_setting('dasher.retention_request_id', true), '') <> ''
    OR COALESCE(current_setting('dasher.retention_case_matter_reference', true), '') <> ''
    OR COALESCE(current_setting('dasher.retention_expected_lifecycle_revision', true), '') <> ''
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  IF $1 IS NULL OR $5 IS NULL OR $2 NOT IN (
      'materialize_expiry', 'place_hold', 'release_hold', 'claim_cleanup',
      'record_attempt', 'purge'
    ) OR $3 IS NULL OR $4 IS NULL OR btrim($4) <> $4
    OR char_length($4) NOT BETWEEN 1 AND 200 OR $4 ~ '[[:cntrl:]]'
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  v_binding_gate := hashtextextended(
    'dasher:retention-principal-binding:v1|postgres_session_user|' ||
      session_user::text,
    0
  );
  PERFORM pg_advisory_xact_lock(v_binding_gate);
  WITH exact_binding AS MATERIALIZED (
    SELECT retention_service_principal_id, principal_revision,
      authority_scope, scope_organization_id, enabled, can_initialize,
      can_materialize_expiry, can_place_hold, can_release_hold,
      can_claim_cleanup, can_record_attempt, can_purge
    FROM dasher.retention_service_principal_allowlist
    WHERE binding_kind = 'postgres_session_user'
      AND binding_subject = session_user
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
  SELECT retention_service_principal_id, principal_revision, authority_scope,
      scope_organization_id, enabled, can_initialize,
      CASE $2
        WHEN 'materialize_expiry' THEN can_materialize_expiry
        WHEN 'place_hold' THEN can_place_hold
        WHEN 'release_hold' THEN can_release_hold
        WHEN 'claim_cleanup' THEN can_claim_cleanup
        WHEN 'record_attempt' THEN can_record_attempt
        WHEN 'purge' THEN can_purge
        ELSE false
      END
    INTO v_principal_id, v_principal_revision, v_authority_scope,
      v_scope_organization_id, v_enabled, v_can_initialize,
      v_capability_allowed
  FROM unique_latest;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  WITH RECURSIVE authority_chain AS (
    SELECT principal_revision, predecessor_revision, predecessor_sha256,
      revision_sha256
    FROM dasher.retention_service_principal_allowlist
    WHERE retention_service_principal_id = v_principal_id
      AND principal_revision = v_principal_revision
    UNION ALL
    SELECT predecessor.principal_revision, predecessor.predecessor_revision,
      predecessor.predecessor_sha256, predecessor.revision_sha256
    FROM dasher.retention_service_principal_allowlist AS predecessor
    JOIN authority_chain AS successor
      ON predecessor.retention_service_principal_id = v_principal_id
     AND predecessor.principal_revision = successor.predecessor_revision
     AND predecessor.revision_sha256 = successor.predecessor_sha256
  )
  SELECT count(*), min(principal_revision),
      bool_and(
        (principal_revision = 1 AND predecessor_revision IS NULL
          AND predecessor_sha256 IS NULL)
        OR
        (principal_revision > 1 AND predecessor_revision = principal_revision - 1
          AND predecessor_sha256 IS NOT NULL)
      )
    INTO v_chain_count, v_chain_min_revision, v_chain_valid
  FROM authority_chain;
  IF v_chain_count <> v_principal_revision OR v_chain_min_revision <> 1
    OR v_chain_valid IS DISTINCT FROM true OR NOT v_enabled
    OR NOT v_can_initialize OR NOT v_capability_allowed
    OR v_authority_scope <> 'platform_operator'
    OR v_scope_organization_id IS NOT NULL
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  PERFORM set_config('dasher.retention_principal_id', v_principal_id::text, true);
  PERFORM set_config('dasher.retention_principal_revision', v_principal_revision::text, true);
  PERFORM set_config('dasher.retention_authority_scope', v_authority_scope, true);
  PERFORM set_config('dasher.retention_capability', $2, true);
  PERFORM set_config('dasher.retention_target_organization_id', $5::text, true);
  PERFORM set_config('dasher.retention_target_dashboard_id', $1::text, true);
  PERFORM set_config('dasher.retention_request_id', $3::text, true);
  PERFORM set_config('dasher.retention_case_matter_reference', $4, true);
  PERFORM set_config('dasher.retention_phase', 'target_discovery', true);
  SELECT dashboard.organization_id INTO v_target_organization_id
  FROM dasher.dashboards AS dashboard
  WHERE dashboard.organization_id = $5
    AND dashboard.dashboard_id = $1;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  v_organization_gate := hashtextextended(
    'dasher:organization:v1|' || v_target_organization_id::text,
    0
  );
  PERFORM pg_advisory_xact_lock(v_organization_gate);
  PERFORM set_config('dasher.retention_capability', $2, true);
  PERFORM set_config('dasher.retention_phase', 'authorized', true);
  PERFORM 1 FROM dasher.retention_service_principal_allowlist AS authority
  WHERE authority.retention_service_principal_id = v_principal_id
    AND authority.principal_revision = v_principal_revision
    AND authority.binding_kind = 'postgres_session_user'
    AND authority.binding_subject = session_user AND authority.enabled
    AND authority.authority_scope = 'platform_operator'
    AND authority.scope_organization_id IS NULL
    AND CASE $2
      WHEN 'materialize_expiry' THEN authority.can_materialize_expiry
      WHEN 'place_hold' THEN authority.can_place_hold
      WHEN 'release_hold' THEN authority.can_release_hold
      WHEN 'claim_cleanup' THEN authority.can_claim_cleanup
      WHEN 'record_attempt' THEN authority.can_record_attempt
      WHEN 'purge' THEN authority.can_purge
      ELSE false
    END
    AND NOT EXISTS (
      SELECT 1 FROM dasher.retention_service_principal_allowlist AS later
      WHERE later.retention_service_principal_id = authority.retention_service_principal_id
        AND later.principal_revision > authority.principal_revision
    );
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
END
$function$;

CREATE FUNCTION dasher_retention_api.materialize_dashboard_expiry(uuid, bigint, uuid, text, uuid)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_organization_id uuid;
  v_authority_revision bigint;
  v_dashboard dasher.dashboards%ROWTYPE;
  v_now timestamptz;
  v_proof_sha256 bytea;
  v_ledger_sequence bigint;
BEGIN
  IF current_user <> 'dasher_retention_definer'::name
    OR $1 IS NULL OR $2 < 0 OR $3 IS NULL OR $4 IS NULL
    OR $5 IS NULL
    OR btrim($4) <> $4 OR char_length($4) NOT BETWEEN 1 AND 64
    OR $4 ~ '[[:cntrl:]]'
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  PERFORM dasher_retention_api.initialize_operator_context(
    $1, 'materialize_expiry', $3, $4, $5
  );
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
    AND authority.scope_organization_id IS NULL AND authority.can_materialize_expiry
    AND NOT EXISTS (
      SELECT 1 FROM dasher.retention_service_principal_allowlist AS later
      WHERE later.retention_service_principal_id = authority.retention_service_principal_id
        AND later.principal_revision > authority.principal_revision
    );
  IF NOT FOUND THEN
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
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  IF v_dashboard.lifecycle_state = 'access_revoked'
    AND v_dashboard.revocation_reason = 'expired'
  THEN
    RETURN;
  END IF;
  v_now := clock_timestamp();
  IF v_dashboard.lifecycle_revision <> $2 OR v_dashboard.current_kind <> 'disposable'
    OR v_dashboard.lifecycle_state NOT IN ('draft', 'active')
    OR v_dashboard.effective_expires_at IS NULL
    OR v_now < v_dashboard.effective_expires_at
    OR v_dashboard.access_revoked_at IS NOT NULL OR v_dashboard.purged_at IS NOT NULL
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;
  v_proof_sha256 := sha256(
    uuid_send(v_organization_id) || uuid_send($1) || int8send(($2 + 1)::bigint)
      || timestamptz_send(v_now) || convert_to('expired', 'UTF8')
  );
  PERFORM set_config(
    'dasher.retention_expected_lifecycle_revision', $2::text, true
  );
  UPDATE dasher.dashboards SET lifecycle_state = 'access_revoked',
    access_revoked_at = v_now, revocation_reason = 'expired',
    purge_after = v_now + interval '24 hours', lifecycle_revision = lifecycle_revision + 1,
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
    $3, v_organization_id, $1, $2 + 1, 'expired',
    v_dashboard.current_kind, v_dashboard.current_kind,
    v_dashboard.lifecycle_state, 'access_revoked', v_now, NULL, session_user::text,
    v_authority_revision, v_dashboard.retention_policy_revision,
    current_setting('dasher.retention_request_id', true)::uuid, NULL, v_proof_sha256
  );
  INSERT INTO dasher.audit_events (
    audit_event_id, organization_id, occurred_at, actor_kind, actor_user_id,
    actor_service, authority_revision, request_id, job_id, action, target_type,
    target_id, outcome, content_sha256, source_ref, provider,
    credential_version, usage_units, cost_minor_units, deployment_revision
  ) VALUES (
    $3, v_organization_id, v_now, 'service', NULL, session_user::text,
    v_authority_revision, current_setting('dasher.retention_request_id', true)::uuid,
    NULL, 'dashboard.expired', 'dashboard', $1, 'succeeded', v_proof_sha256,
    NULL, NULL, NULL, NULL, NULL, $4
  );
END
$function$;

CREATE FUNCTION dasher_retention_api.place_dashboard_legal_hold(uuid, uuid, text, bytea, bigint, uuid, text, uuid)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_organization_id uuid;
  v_authority_revision bigint;
  v_dashboard dasher.dashboards%ROWTYPE;
  v_now timestamptz;
BEGIN
  IF current_user <> 'dasher_retention_definer'::name
    OR $1 IS NULL OR $2 IS NULL OR $3 IS NULL OR btrim($3) <> $3
    OR $8 IS NULL
    OR char_length($3) NOT BETWEEN 1 AND 200 OR $4 IS NULL
    OR $3 ~ '[[:cntrl:]]' OR octet_length($4) <> 32 OR $5 < 0
    OR $6 IS NULL OR $7 IS NULL OR btrim($7) <> $7
    OR char_length($7) NOT BETWEEN 1 AND 64 OR $7 ~ '[[:cntrl:]]'
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  PERFORM dasher_retention_api.initialize_operator_context(
    $1, 'place_hold', $6, $3, $8
  );
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
    AND authority.scope_organization_id IS NULL AND authority.can_place_hold
    AND NOT EXISTS (
      SELECT 1 FROM dasher.retention_service_principal_allowlist AS later
      WHERE later.retention_service_principal_id = authority.retention_service_principal_id
        AND later.principal_revision > authority.principal_revision
    );
  IF NOT FOUND THEN
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
    AND dashboard.lifecycle_revision = $5 AND dashboard.lifecycle_state <> 'cleaned'
    AND dashboard.purge_started_at IS NULL AND dashboard.purged_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;
  PERFORM 1 FROM dasher.dashboard_version_snapshots AS link
  WHERE link.organization_id = v_organization_id AND link.dashboard_id = $1
  ORDER BY link.snapshot_id, link.version_id FOR SHARE;
  PERFORM 1 FROM dasher.dashboard_version_evidence AS link
  WHERE link.organization_id = v_organization_id AND link.dashboard_id = $1
  ORDER BY link.evidence_id, link.version_id FOR SHARE;
  PERFORM 1 FROM dasher.dashboard_artifacts AS artifact
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
  ORDER BY artifact.artifact_id FOR SHARE;
  v_now := clock_timestamp();
  PERFORM set_config(
    'dasher.retention_expected_lifecycle_revision', $5::text, true
  );
  UPDATE dasher.dashboards SET lifecycle_revision = lifecycle_revision + 1
  WHERE organization_id = v_organization_id AND dashboard_id = $1
    AND lifecycle_revision = $5;
  INSERT INTO dasher.dashboard_legal_holds (
    organization_id, dashboard_id, hold_id, case_matter_reference,
    placed_by_principal_id, placed_authority_revision, placed_actor,
    placed_reason_sha256, placed_at, retention_policy_revision
  ) VALUES (v_organization_id, $1, $2, $3,
      current_setting('dasher.retention_principal_id', true)::uuid,
      v_authority_revision, session_user::text, $4, v_now,
      v_dashboard.retention_policy_revision);
  INSERT INTO dasher.snapshot_reference_claims (
    organization_id, snapshot_id, reference_claim_id, dashboard_id,
    version_id, claim_kind, hold_id, created_at
  ) SELECT DISTINCT ON (link.snapshot_id)
      link.organization_id, link.snapshot_id, $2, link.dashboard_id,
      link.version_id, 'retention_only', $2, v_now
    FROM dasher.dashboard_version_snapshots AS link
    WHERE link.organization_id = v_organization_id AND link.dashboard_id = $1
    ORDER BY link.snapshot_id, link.version_id;
  INSERT INTO dasher.evidence_reference_claims (
    organization_id, evidence_id, reference_claim_id, dashboard_id,
    version_id, claim_kind, hold_id, created_at
  ) SELECT DISTINCT ON (link.evidence_id)
      link.organization_id, link.evidence_id, $2, link.dashboard_id,
      link.version_id, 'retention_only', $2, v_now
    FROM dasher.dashboard_version_evidence AS link
    WHERE link.organization_id = v_organization_id AND link.dashboard_id = $1
    ORDER BY link.evidence_id, link.version_id;
  INSERT INTO dasher.artifact_reference_claims (
    organization_id, artifact_id, reference_claim_id, dashboard_id,
    version_id, claim_kind, hold_id, created_at
  ) SELECT DISTINCT ON (artifact.artifact_id)
      artifact.organization_id, artifact.artifact_id, $2,
      target_claim.dashboard_id, target_claim.version_id,
      'retention_only', $2, v_now
    FROM dasher.dashboard_artifacts AS artifact
    JOIN dasher.artifact_reference_claims AS target_claim
      ON target_claim.organization_id = artifact.organization_id
     AND target_claim.artifact_id = artifact.artifact_id
     AND target_claim.dashboard_id = $1
     AND target_claim.claim_kind = 'access_bearing'
     AND target_claim.hold_id IS NULL
    WHERE artifact.organization_id = v_organization_id
      AND (
        (artifact.ownership_class = 'dashboard_owned'
          AND artifact.dashboard_id = $1)
        OR artifact.ownership_class = 'shared'
      )
    ORDER BY artifact.artifact_id, target_claim.version_id;
  INSERT INTO dasher.dashboard_lifecycle_events (
    lifecycle_event_id, organization_id, dashboard_id, lifecycle_revision,
    event_kind, from_kind, to_kind, from_state, to_state, occurred_at,
    actor_user_id, actor_service, authority_revision, retention_policy_revision,
    request_id, job_id, reason_sha256
  ) VALUES (
    $6, v_organization_id, $1, $5 + 1, 'legal_hold_placed',
    v_dashboard.current_kind, v_dashboard.current_kind,
    v_dashboard.lifecycle_state, v_dashboard.lifecycle_state, v_now, NULL,
    session_user::text, v_authority_revision,
    v_dashboard.retention_policy_revision,
    current_setting('dasher.retention_request_id', true)::uuid, NULL, $4
  );
  INSERT INTO dasher.audit_events (
    audit_event_id, organization_id, occurred_at, actor_kind, actor_user_id,
    actor_service, authority_revision, request_id, job_id, action, target_type,
    target_id, outcome, content_sha256, source_ref, provider,
    credential_version, usage_units, cost_minor_units, deployment_revision
  ) VALUES (
    $6, v_organization_id, v_now, 'service', NULL, session_user::text,
    v_authority_revision, current_setting('dasher.retention_request_id', true)::uuid,
    NULL, 'dashboard.legal_hold_placed', 'dashboard', $1, 'succeeded', $4,
    NULL, NULL, NULL, NULL, NULL, $7
  );
END
$function$;

CREATE FUNCTION dasher_retention_api.release_dashboard_legal_hold(uuid, uuid, bytea, bigint, uuid, text, uuid)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_organization_id uuid;
  v_authority_revision bigint;
  v_dashboard dasher.dashboards%ROWTYPE;
  v_now timestamptz;
BEGIN
  IF current_user <> 'dasher_retention_definer'::name
    OR $1 IS NULL OR $2 IS NULL OR $3 IS NULL OR octet_length($3) <> 32
    OR $7 IS NULL
    OR $4 < 0 OR $5 IS NULL OR $6 IS NULL OR btrim($6) <> $6
    OR char_length($6) NOT BETWEEN 1 AND 64 OR $6 ~ '[[:cntrl:]]'
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  PERFORM dasher_retention_api.initialize_operator_context(
    $1, 'release_hold', $5, $6, $7
  );
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
    AND authority.scope_organization_id IS NULL AND authority.can_release_hold
    AND NOT EXISTS (
      SELECT 1 FROM dasher.retention_service_principal_allowlist AS later
      WHERE later.retention_service_principal_id = authority.retention_service_principal_id
        AND later.principal_revision > authority.principal_revision
    );
  IF NOT FOUND THEN
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
    AND dashboard.lifecycle_revision = $4 AND dashboard.lifecycle_state <> 'cleaned'
    AND dashboard.purged_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;
  PERFORM 1 FROM dasher.dashboard_legal_holds AS hold
  WHERE hold.organization_id = v_organization_id AND hold.dashboard_id = $1
    AND hold.hold_id = $2 AND hold.released_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;
  PERFORM 1 FROM dasher.snapshot_reference_claims AS claim
  WHERE claim.organization_id = v_organization_id AND claim.dashboard_id = $1
    AND claim.claim_kind = 'retention_only' AND claim.hold_id = $2
  ORDER BY claim.snapshot_id FOR UPDATE;
  PERFORM 1 FROM dasher.evidence_reference_claims AS claim
  WHERE claim.organization_id = v_organization_id AND claim.dashboard_id = $1
    AND claim.claim_kind = 'retention_only' AND claim.hold_id = $2
  ORDER BY claim.evidence_id FOR UPDATE;
  PERFORM 1 FROM dasher.artifact_reference_claims AS claim
  WHERE claim.organization_id = v_organization_id AND claim.dashboard_id = $1
    AND claim.claim_kind = 'retention_only' AND claim.hold_id = $2
  ORDER BY claim.artifact_id FOR UPDATE;
  v_now := clock_timestamp();
  PERFORM set_config(
    'dasher.retention_expected_lifecycle_revision', $4::text, true
  );
  UPDATE dasher.dashboards SET lifecycle_revision = lifecycle_revision + 1
  WHERE organization_id = v_organization_id AND dashboard_id = $1
    AND lifecycle_revision = $4;
  PERFORM set_config(
    'dasher.retention_expected_lifecycle_revision', ($4 + 1)::text, true
  );
  UPDATE dasher.dashboard_legal_holds SET released_at = v_now,
    released_by_principal_id = current_setting(
      'dasher.retention_principal_id', true
    )::uuid,
    released_authority_revision = current_setting(
      'dasher.retention_principal_revision', true
    )::bigint,
    released_actor = session_user::text, released_reason_sha256 = $3
  WHERE organization_id = v_organization_id
    AND dashboard_id = $1 AND hold_id = $2 AND released_at IS NULL;
  DELETE FROM dasher.snapshot_reference_claims
  WHERE organization_id = v_organization_id AND dashboard_id = $1
    AND claim_kind = 'retention_only' AND hold_id = $2;
  DELETE FROM dasher.evidence_reference_claims
  WHERE organization_id = v_organization_id AND dashboard_id = $1
    AND claim_kind = 'retention_only' AND hold_id = $2;
  DELETE FROM dasher.artifact_reference_claims
  WHERE organization_id = v_organization_id AND dashboard_id = $1
    AND claim_kind = 'retention_only' AND hold_id = $2;
  INSERT INTO dasher.dashboard_lifecycle_events (
    lifecycle_event_id, organization_id, dashboard_id, lifecycle_revision,
    event_kind, from_kind, to_kind, from_state, to_state, occurred_at,
    actor_user_id, actor_service, authority_revision, retention_policy_revision,
    request_id, job_id, reason_sha256
  ) VALUES (
    $5, v_organization_id, $1, $4 + 1, 'legal_hold_released',
    v_dashboard.current_kind, v_dashboard.current_kind,
    v_dashboard.lifecycle_state, v_dashboard.lifecycle_state, v_now, NULL,
    session_user::text, v_authority_revision,
    v_dashboard.retention_policy_revision,
    current_setting('dasher.retention_request_id', true)::uuid, NULL, $3
  );
  INSERT INTO dasher.audit_events (
    audit_event_id, organization_id, occurred_at, actor_kind, actor_user_id,
    actor_service, authority_revision, request_id, job_id, action, target_type,
    target_id, outcome, content_sha256, source_ref, provider,
    credential_version, usage_units, cost_minor_units, deployment_revision
  ) VALUES (
    $5, v_organization_id, v_now, 'service', NULL, session_user::text,
    v_authority_revision, current_setting('dasher.retention_request_id', true)::uuid,
    NULL, 'dashboard.legal_hold_released', 'dashboard', $1, 'succeeded', $3,
    NULL, NULL, NULL, NULL, NULL, $6
  );
END
$function$;

CREATE FUNCTION dasher_retention_api.claim_dashboard_cleanup(uuid, bigint, bytea, interval, uuid, text, uuid)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_organization_id uuid;
  v_authority_revision bigint;
  v_dashboard dasher.dashboards%ROWTYPE;
  v_now timestamptz;
  v_target_state text;
  v_event_kind text;
  v_audit_action text;
  v_step text;
  v_transition_proof_sha256 bytea;
BEGIN
  IF current_user <> 'dasher_retention_definer'::name
    OR $1 IS NULL OR $2 < 0
    OR $7 IS NULL
    OR ($3 IS NOT NULL AND octet_length($3) <> 32)
    OR $4 IS NULL OR $4 <= interval '0 seconds' OR $4 > interval '15 minutes'
    OR $5 IS NULL OR $6 IS NULL OR btrim($6) <> $6
    OR char_length($6) NOT BETWEEN 1 AND 64 OR $6 ~ '[[:cntrl:]]'
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  PERFORM dasher_retention_api.initialize_operator_context(
    $1, 'claim_cleanup', $5, $6, $7
  );
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
    AND authority.scope_organization_id IS NULL AND authority.can_claim_cleanup
    AND NOT EXISTS (
      SELECT 1 FROM dasher.retention_service_principal_allowlist AS later
      WHERE later.retention_service_principal_id = authority.retention_service_principal_id
        AND later.principal_revision > authority.principal_revision
    );
  IF NOT FOUND THEN
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
    AND dashboard.lifecycle_state IN ('access_revoked', 'quarantined', 'purge_eligible')
    AND dashboard.access_revoked_at IS NOT NULL AND dashboard.purge_after IS NOT NULL
    AND dashboard.purged_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;
  PERFORM 1 FROM dasher.dashboard_legal_holds AS hold
  WHERE hold.organization_id = v_organization_id AND hold.dashboard_id = $1
  ORDER BY hold.hold_id FOR SHARE;
  v_now := clock_timestamp();
  IF v_dashboard.lifecycle_state = 'access_revoked' AND $3 IS NOT NULL THEN
    v_target_state := 'quarantined';
    v_event_kind := 'cleanup_started';
    v_audit_action := 'dashboard.cleanup_started';
    v_step := 'quarantined';
  ELSIF v_dashboard.lifecycle_state = 'quarantined'
    AND v_now >= v_dashboard.purge_after
    AND NOT EXISTS (
      SELECT 1 FROM dasher.dashboard_legal_holds AS hold
      WHERE hold.organization_id = v_organization_id AND hold.dashboard_id = $1
        AND hold.released_at IS NULL
    )
  THEN
    v_target_state := 'purge_eligible';
    v_event_kind := 'purge_eligible';
    v_audit_action := 'dashboard.purge_eligible';
    v_step := 'purge_eligible';
  ELSE
    v_target_state := v_dashboard.lifecycle_state;
    v_step := CASE v_dashboard.lifecycle_state
      WHEN 'access_revoked' THEN 'drain_and_cancel'
      WHEN 'quarantined' THEN 'prepare_finalizers'
      ELSE 'await_purge' END;
  END IF;
  IF v_target_state IS DISTINCT FROM v_dashboard.lifecycle_state THEN
    v_transition_proof_sha256 := COALESCE($3, sha256(
      uuid_send(v_organization_id) || uuid_send($1)
        || int8send(($2 + 1)::bigint) || timestamptz_send(v_now)
        || convert_to(v_event_kind, 'UTF8')
    ));
    PERFORM set_config(
      'dasher.retention_expected_lifecycle_revision', $2::text, true
    );
    UPDATE dasher.dashboards SET lifecycle_state = v_target_state,
      lifecycle_revision = lifecycle_revision + 1
    WHERE organization_id = v_organization_id AND dashboard_id = $1
      AND lifecycle_revision = $2;
  END IF;
  INSERT INTO dasher.dashboard_cleanup_coordination (
    organization_id, dashboard_id, current_step, lease_owner,
    lease_expires_at, expected_lifecycle_revision, next_attempt_at
  ) VALUES (
    v_organization_id, $1, v_step, session_user, v_now + $4,
    CASE WHEN v_target_state IS DISTINCT FROM v_dashboard.lifecycle_state
      THEN $2 + 1 ELSE $2 END, v_now
  ) ON CONFLICT (organization_id, dashboard_id) DO UPDATE
    SET current_step = EXCLUDED.current_step, lease_owner = EXCLUDED.lease_owner,
        lease_expires_at = EXCLUDED.lease_expires_at,
        expected_lifecycle_revision = EXCLUDED.expected_lifecycle_revision
    WHERE (dasher.dashboard_cleanup_coordination.lease_expires_at IS NULL
       OR dasher.dashboard_cleanup_coordination.lease_expires_at <= v_now)
      AND (dasher.dashboard_cleanup_coordination.next_attempt_at IS NULL
       OR dasher.dashboard_cleanup_coordination.next_attempt_at <= v_now);
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;
  IF v_target_state IS DISTINCT FROM v_dashboard.lifecycle_state THEN
    INSERT INTO dasher.dashboard_lifecycle_events (
      lifecycle_event_id, organization_id, dashboard_id, lifecycle_revision,
      event_kind, from_kind, to_kind, from_state, to_state, occurred_at,
      actor_user_id, actor_service, authority_revision, retention_policy_revision,
      request_id, job_id, reason_sha256
    ) VALUES (
      $5, v_organization_id, $1, $2 + 1, v_event_kind,
      v_dashboard.current_kind, v_dashboard.current_kind,
      v_dashboard.lifecycle_state, v_target_state, v_now, NULL,
      session_user::text, v_authority_revision,
      v_dashboard.retention_policy_revision,
      current_setting('dasher.retention_request_id', true)::uuid, NULL,
      v_transition_proof_sha256
    );
    INSERT INTO dasher.audit_events (
      audit_event_id, organization_id, occurred_at, actor_kind, actor_user_id,
      actor_service, authority_revision, request_id, job_id, action, target_type,
      target_id, outcome, content_sha256, source_ref, provider,
      credential_version, usage_units, cost_minor_units, deployment_revision
    ) VALUES (
      $5, v_organization_id, v_now, 'service', NULL, session_user::text,
      v_authority_revision,
      current_setting('dasher.retention_request_id', true)::uuid, NULL,
      v_audit_action, 'dashboard', $1, 'succeeded', v_transition_proof_sha256,
      NULL, NULL, NULL,
      NULL, NULL, $6
    );
  END IF;
END
$function$;

CREATE FUNCTION dasher_retention_api.record_dashboard_cleanup_attempt(uuid, uuid, text, text, integer, integer, integer, bytea, uuid)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_organization_id uuid;
  v_dashboard dasher.dashboards%ROWTYPE;
  v_retry_count bigint;
  v_now timestamptz;
BEGIN
  IF current_user <> 'dasher_retention_definer'::name
    OR $1 IS NULL OR $2 IS NULL OR $3 IS NULL OR btrim($3) <> $3
    OR $9 IS NULL
    OR char_length($3) NOT BETWEEN 1 AND 200 OR $3 ~ '[[:cntrl:]]'
    OR $4 NOT IN (
      'succeeded', 'retryable_failure', 'held', 'outstanding_reference',
      'already_complete'
    )
    OR $5 < 0 OR $6 < 0 OR $7 < 0 OR ($8 IS NOT NULL AND octet_length($8) <> 32)
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  PERFORM dasher_retention_api.initialize_operator_context(
    $1, 'record_attempt', $2, $3, $9
  );
  v_organization_id := current_setting(
    'dasher.retention_target_organization_id', true
  )::uuid;
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
    AND authority.scope_organization_id IS NULL AND authority.can_record_attempt
    AND NOT EXISTS (
      SELECT 1 FROM dasher.retention_service_principal_allowlist AS later
      WHERE later.retention_service_principal_id = authority.retention_service_principal_id
        AND later.principal_revision > authority.principal_revision
    );
  IF NOT FOUND THEN
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
    AND dashboard.lifecycle_state IN ('access_revoked', 'quarantined', 'purge_eligible')
    AND dashboard.purged_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  PERFORM 1 FROM dasher.dashboard_cleanup_coordination AS coordination
  WHERE coordination.organization_id = v_organization_id
    AND coordination.dashboard_id = $1 AND coordination.current_step = $3
    AND coordination.lease_owner = session_user
    AND coordination.expected_lifecycle_revision = v_dashboard.lifecycle_revision
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;
  v_now := clock_timestamp();
  SELECT count(*) + 1 INTO v_retry_count
  FROM dasher.dashboard_cleanup_attempts AS attempt
  WHERE attempt.organization_id = v_organization_id
    AND attempt.dashboard_id = $1
    AND attempt.result NOT IN ('succeeded', 'already_complete');
  PERFORM 1 FROM dasher.dashboard_cleanup_coordination AS coordination
  WHERE coordination.organization_id = v_organization_id
    AND coordination.dashboard_id = $1 AND coordination.current_step = $3
    AND coordination.lease_owner = session_user
    AND coordination.expected_lifecycle_revision = v_dashboard.lifecycle_revision
    AND coordination.lease_expires_at > v_now;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;
  INSERT INTO dasher.dashboard_cleanup_attempts (
    organization_id, dashboard_id, cleanup_attempt_id, step, started_at,
    finished_at, result, released_claim_count, deleted_resource_count,
    deferred_claim_count, failure_code, proof_sha256
  ) VALUES (
    v_organization_id, $1, $2, $3, v_now, v_now, $4,
    $5, $6, $7, CASE WHEN $4 = 'retryable_failure'
      THEN 'cleanup_retryable_failure' END, $8
  );
  UPDATE dasher.dashboard_cleanup_coordination
  SET lease_owner = NULL, lease_expires_at = NULL,
      next_attempt_at = CASE WHEN $4 IN ('succeeded', 'already_complete') THEN NULL
        WHEN v_retry_count = 1 THEN v_now + interval '5 minutes'
        WHEN v_retry_count = 2 THEN v_now + interval '30 minutes'
        WHEN v_retry_count = 3 THEN v_now + interval '2 hours'
        WHEN v_retry_count = 4 THEN v_now + interval '12 hours'
        ELSE v_now + interval '1 day' END,
      completion_proof_sha256 = CASE
        WHEN $4 IN ('succeeded', 'already_complete') THEN $8 END
  WHERE organization_id = v_organization_id
    AND dashboard_id = $1 AND lease_owner = session_user;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_conflict';
  END IF;
END
$function$;

CREATE FUNCTION dasher_retention_api.purge_dashboard(uuid, bigint, bytea, uuid, text, uuid)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
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
  ORDER BY hold.hold_id FOR SHARE OF hold;
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
  SELECT * INTO v_coordination
  FROM dasher.dashboard_cleanup_coordination AS coordination
  WHERE coordination.organization_id = v_organization_id
    AND coordination.dashboard_id = $1
    AND coordination.expected_lifecycle_revision = $2
  FOR UPDATE OF coordination;
  IF NOT FOUND OR (
    v_coordination.completion_proof_sha256 IS NOT NULL
    AND v_coordination.completion_proof_sha256 <> $3
  ) THEN
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
END
$function$;

CREATE FUNCTION dasher_private.reject_dashboard_append_mutation()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog
AS $function$
BEGIN
  IF TG_LEVEL <> 'ROW' OR TG_WHEN <> 'BEFORE'
    OR TG_OP NOT IN ('UPDATE', 'DELETE')
  THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid append-only trigger invocation';
  END IF;
  RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'append-only relation rejects update and delete';
END
$function$;

CREATE FUNCTION dasher_private.enforce_dashboard_transition()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog
AS $function$
DECLARE
  v_phase text := current_setting('dasher.retention_phase', true);
  v_capability text := current_setting('dasher.retention_capability', true);
  v_revision_increment boolean := NEW.lifecycle_revision = OLD.lifecycle_revision + 1;
  v_purge_start boolean :=
    OLD.lifecycle_state = 'purge_eligible'
    AND NEW.lifecycle_state = 'purge_eligible'
    AND OLD.purge_started_at IS NULL AND NEW.purge_started_at IS NOT NULL
    AND NEW.lifecycle_revision = OLD.lifecycle_revision;
BEGIN
  IF TG_LEVEL <> 'ROW' OR TG_WHEN <> 'BEFORE' OR TG_OP <> 'UPDATE'
    OR OLD.organization_id IS DISTINCT FROM NEW.organization_id
    OR OLD.dashboard_id IS DISTINCT FROM NEW.dashboard_id
    OR OLD.title IS DISTINCT FROM NEW.title
    OR OLD.created_by_user_id IS DISTINCT FROM NEW.created_by_user_id
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
    OR OLD.created_kind IS DISTINCT FROM NEW.created_kind
    OR OLD.original_expires_at IS DISTINCT FROM NEW.original_expires_at
    OR OLD.retention_policy_revision IS DISTINCT FROM NEW.retention_policy_revision
    OR OLD.tombstone_lineage_id IS DISTINCT FROM NEW.tombstone_lineage_id
    OR OLD.restored_from_tombstone_lineage_id IS DISTINCT FROM NEW.restored_from_tombstone_lineage_id
    OR (NOT v_revision_increment AND NOT v_purge_start)
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;

  IF current_user = 'dasher_security_definer'::name THEN
    IF dasher_private.context_organization_id() IS DISTINCT FROM OLD.organization_id
      OR dasher_private.context_user_id() IS NULL
      OR current_setting('dasher.lifecycle_expected_revision', true)::bigint
        IS DISTINCT FROM OLD.lifecycle_revision
      OR OLD.purged_at IS NOT NULL
      OR NOT (
        (
          OLD.lifecycle_state IN ('draft', 'active')
          AND NEW.lifecycle_state = 'active'
          AND NEW.head_version_id IS DISTINCT FROM OLD.head_version_id
          AND NEW.head_version_id IS NOT NULL
          AND ROW(
            NEW.current_kind, NEW.effective_expires_at, NEW.access_revoked_at,
            NEW.revocation_reason, NEW.purge_after, NEW.purge_started_at,
            NEW.purged_at, NEW.promoted_at, NEW.archived_at
          ) IS NOT DISTINCT FROM ROW(
            OLD.current_kind, OLD.effective_expires_at, OLD.access_revoked_at,
            OLD.revocation_reason, OLD.purge_after, OLD.purge_started_at,
            OLD.purged_at, OLD.promoted_at, OLD.archived_at
          )
          AND NEW.capability_epoch = OLD.capability_epoch
          AND NEW.cache_epoch = OLD.cache_epoch
        ) OR (
          OLD.current_kind = 'disposable' AND NEW.current_kind = 'durable'
          AND OLD.lifecycle_state = 'active' AND NEW.lifecycle_state = 'active'
          AND OLD.head_version_id IS NOT NULL
          AND NEW.head_version_id IS NOT DISTINCT FROM OLD.head_version_id
          AND OLD.effective_expires_at IS NOT NULL
          AND NEW.effective_expires_at IS NULL
          AND OLD.promoted_at IS NULL AND NEW.promoted_at IS NOT NULL
          AND ROW(
            NEW.access_revoked_at, NEW.revocation_reason, NEW.purge_after,
            NEW.purge_started_at, NEW.purged_at, NEW.archived_at
          ) IS NOT DISTINCT FROM ROW(
            OLD.access_revoked_at, OLD.revocation_reason, OLD.purge_after,
            OLD.purge_started_at, OLD.purged_at, OLD.archived_at
          )
          AND NEW.capability_epoch = OLD.capability_epoch + 1
          AND NEW.cache_epoch = OLD.cache_epoch + 1
        ) OR (
          OLD.current_kind = 'durable'
          AND NEW.current_kind = 'durable'
          AND NEW.head_version_id IS NOT DISTINCT FROM OLD.head_version_id
          AND (
            (OLD.lifecycle_state = 'active' AND NEW.lifecycle_state = 'archived'
              AND OLD.head_version_id IS NOT NULL
              AND OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL)
            OR
            (OLD.lifecycle_state = 'archived' AND NEW.lifecycle_state = 'active'
              AND OLD.head_version_id IS NOT NULL
              AND OLD.archived_at IS NOT NULL AND NEW.archived_at IS NULL)
          )
          AND ROW(
            NEW.effective_expires_at, NEW.access_revoked_at,
            NEW.revocation_reason, NEW.purge_after, NEW.purge_started_at,
            NEW.purged_at, NEW.promoted_at
          ) IS NOT DISTINCT FROM ROW(
            OLD.effective_expires_at, OLD.access_revoked_at,
            OLD.revocation_reason, OLD.purge_after, OLD.purge_started_at,
            OLD.purged_at, OLD.promoted_at
          )
          AND NEW.capability_epoch = OLD.capability_epoch + 1
          AND NEW.cache_epoch = OLD.cache_epoch + 1
        ) OR (
          OLD.lifecycle_state IN ('draft', 'active', 'archived')
          AND NEW.lifecycle_state = 'access_revoked'
          AND OLD.access_revoked_at IS NULL AND NEW.access_revoked_at IS NOT NULL
          AND NEW.revocation_reason = 'explicit_delete'
          AND NEW.purge_after = NEW.access_revoked_at + interval '24 hours'
          AND ROW(
            NEW.current_kind, NEW.effective_expires_at, NEW.purge_started_at,
            NEW.purged_at, NEW.promoted_at, NEW.archived_at,
            NEW.head_version_id
          ) IS NOT DISTINCT FROM ROW(
            OLD.current_kind, OLD.effective_expires_at, OLD.purge_started_at,
            OLD.purged_at, OLD.promoted_at, OLD.archived_at,
            OLD.head_version_id
          )
          AND NEW.capability_epoch = OLD.capability_epoch + 1
          AND NEW.cache_epoch = OLD.cache_epoch + 1
        )
      )
    THEN
      RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
    END IF;
  ELSIF current_user = 'dasher_retention_definer'::name THEN
    IF v_phase <> 'authorized'
      OR current_setting('dasher.retention_expected_lifecycle_revision', true)::bigint
        IS DISTINCT FROM OLD.lifecycle_revision
      OR current_setting('dasher.retention_target_organization_id', true)::uuid
        IS DISTINCT FROM OLD.organization_id
      OR current_setting('dasher.retention_target_dashboard_id', true)::uuid
        IS DISTINCT FROM OLD.dashboard_id
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
            WHEN 'materialize_expiry' THEN authority.can_materialize_expiry
            WHEN 'place_hold' THEN authority.can_place_hold
            WHEN 'release_hold' THEN authority.can_release_hold
            WHEN 'claim_cleanup' THEN authority.can_claim_cleanup
            WHEN 'purge' THEN authority.can_purge
            ELSE false
          END
      )
      OR NOT (
        (
          v_capability = 'materialize_expiry'
          AND OLD.lifecycle_state IN ('draft', 'active')
          AND OLD.current_kind = 'disposable'
          AND OLD.access_revoked_at IS NULL
          AND NEW.lifecycle_state = 'access_revoked'
          AND NEW.access_revoked_at IS NOT NULL
          AND NEW.revocation_reason = 'expired'
          AND NEW.purge_after = NEW.access_revoked_at + interval '24 hours'
          AND ROW(
            NEW.current_kind, NEW.effective_expires_at, NEW.purge_started_at,
            NEW.purged_at, NEW.promoted_at, NEW.archived_at,
            NEW.head_version_id
          ) IS NOT DISTINCT FROM ROW(
            OLD.current_kind, OLD.effective_expires_at, OLD.purge_started_at,
            OLD.purged_at, OLD.promoted_at, OLD.archived_at,
            OLD.head_version_id
          )
          AND NEW.capability_epoch = OLD.capability_epoch + 1
          AND NEW.cache_epoch = OLD.cache_epoch + 1
        ) OR (
          v_capability IN ('place_hold', 'release_hold')
          AND ROW(
            NEW.current_kind, NEW.effective_expires_at, NEW.lifecycle_state,
            NEW.access_revoked_at, NEW.revocation_reason, NEW.purge_after,
            NEW.purge_started_at, NEW.purged_at, NEW.promoted_at,
            NEW.archived_at, NEW.head_version_id, NEW.capability_epoch,
            NEW.cache_epoch
          ) IS NOT DISTINCT FROM ROW(
            OLD.current_kind, OLD.effective_expires_at, OLD.lifecycle_state,
            OLD.access_revoked_at, OLD.revocation_reason, OLD.purge_after,
            OLD.purge_started_at, OLD.purged_at, OLD.promoted_at,
            OLD.archived_at, OLD.head_version_id, OLD.capability_epoch,
            OLD.cache_epoch
          )
        ) OR (
          v_capability = 'claim_cleanup'
          AND (
            (OLD.lifecycle_state = 'access_revoked'
              AND NEW.lifecycle_state = 'quarantined')
            OR
            (OLD.lifecycle_state = 'quarantined'
              AND NEW.lifecycle_state = 'purge_eligible')
          )
          AND ROW(
            NEW.current_kind, NEW.effective_expires_at, NEW.access_revoked_at,
            NEW.revocation_reason, NEW.purge_after, NEW.purge_started_at,
            NEW.purged_at, NEW.promoted_at, NEW.archived_at,
            NEW.head_version_id, NEW.capability_epoch, NEW.cache_epoch
          ) IS NOT DISTINCT FROM ROW(
            OLD.current_kind, OLD.effective_expires_at, OLD.access_revoked_at,
            OLD.revocation_reason, OLD.purge_after, OLD.purge_started_at,
            OLD.purged_at, OLD.promoted_at, OLD.archived_at,
            OLD.head_version_id, OLD.capability_epoch, OLD.cache_epoch
          )
        ) OR (
          v_capability = 'purge'
          AND v_purge_start
          AND NEW.head_version_id IS NULL
          AND ROW(
            NEW.current_kind, NEW.effective_expires_at, NEW.access_revoked_at,
            NEW.revocation_reason, NEW.purge_after, NEW.purged_at,
            NEW.promoted_at, NEW.archived_at, NEW.capability_epoch,
            NEW.cache_epoch
          ) IS NOT DISTINCT FROM ROW(
            OLD.current_kind, OLD.effective_expires_at, OLD.access_revoked_at,
            OLD.revocation_reason, OLD.purge_after, OLD.purged_at,
            OLD.promoted_at, OLD.archived_at, OLD.capability_epoch,
            OLD.cache_epoch
          )
        ) OR (
          v_capability = 'purge'
          AND OLD.lifecycle_state = 'purge_eligible'
          AND NEW.lifecycle_state = 'cleaned'
          AND OLD.purge_started_at IS NOT NULL
          AND NEW.purge_started_at IS NOT DISTINCT FROM OLD.purge_started_at
          AND OLD.purged_at IS NULL AND NEW.purged_at IS NOT NULL
          AND OLD.head_version_id IS NULL AND NEW.head_version_id IS NULL
          AND ROW(
            NEW.current_kind, NEW.effective_expires_at, NEW.access_revoked_at,
            NEW.revocation_reason, NEW.purge_after, NEW.promoted_at,
            NEW.archived_at, NEW.capability_epoch, NEW.cache_epoch
          ) IS NOT DISTINCT FROM ROW(
            OLD.current_kind, OLD.effective_expires_at, OLD.access_revoked_at,
            OLD.revocation_reason, OLD.purge_after, OLD.promoted_at,
            OLD.archived_at, OLD.capability_epoch, OLD.cache_epoch
          )
        )
      )
    THEN
      RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
    END IF;
  ELSE
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  RETURN NEW;
END
$function$;

CREATE FUNCTION dasher_private.enforce_retention_mutation()
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
    IF (
      TG_TABLE_NAME = 'dashboard_legal_holds'
      AND v_capability = 'release_hold'
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
    ) OR (
      TG_TABLE_NAME = 'dashboard_tombstones'
      AND v_capability = 'purge'
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
    ) OR (
      TG_TABLE_NAME IN (
        'snapshot_deletion_finalizers',
        'evidence_deletion_finalizers',
        'artifact_deletion_finalizers'
      )
      AND v_capability = 'purge'
      AND OLD.organization_id IS NOT DISTINCT FROM NEW.organization_id
      AND OLD.intent_at IS NOT DISTINCT FROM NEW.intent_at
      AND OLD.expected_claim_set_sha256
        IS NOT DISTINCT FROM NEW.expected_claim_set_sha256
      AND OLD.lease_owner IS NULL AND NEW.lease_owner IS NULL
      AND OLD.lease_expires_at IS NULL AND NEW.lease_expires_at IS NULL
      AND OLD.bytes_deleted_at IS NULL
      AND NEW.lease_owner IS NULL
      AND NEW.lease_expires_at IS NULL
      AND (
        (TG_TABLE_NAME = 'snapshot_deletion_finalizers'
          AND OLD.snapshot_id IS NOT DISTINCT FROM NEW.snapshot_id
          AND NEW.expected_claim_set_sha256 = sha256(
            uuid_send(v_organization_id) || uuid_send(v_dashboard_id)
            || uuid_send(NEW.snapshot_id) || convert_to('snapshot|expected_claim_set=empty', 'UTF8')
          )
          AND NOT EXISTS (
            SELECT 1 FROM dasher.snapshot_reference_claims AS claim
            WHERE claim.organization_id = NEW.organization_id
              AND claim.snapshot_id = NEW.snapshot_id
          ))
        OR
        (TG_TABLE_NAME = 'evidence_deletion_finalizers'
          AND OLD.evidence_id IS NOT DISTINCT FROM NEW.evidence_id
          AND NEW.expected_claim_set_sha256 = sha256(
            uuid_send(v_organization_id) || uuid_send(v_dashboard_id)
            || uuid_send(NEW.evidence_id) || convert_to('evidence|expected_claim_set=empty', 'UTF8')
          )
          AND NOT EXISTS (
            SELECT 1 FROM dasher.evidence_reference_claims AS claim
            WHERE claim.organization_id = NEW.organization_id
              AND claim.evidence_id = NEW.evidence_id
          ))
        OR
        (TG_TABLE_NAME = 'artifact_deletion_finalizers'
          AND OLD.artifact_id IS NOT DISTINCT FROM NEW.artifact_id
          AND NEW.expected_claim_set_sha256 = sha256(
            uuid_send(v_organization_id) || uuid_send(v_dashboard_id)
            || uuid_send(NEW.artifact_id) || convert_to('artifact|expected_claim_set=empty', 'UTF8')
          )
          AND NOT EXISTS (
            SELECT 1 FROM dasher.artifact_reference_claims AS claim
            WHERE claim.organization_id = NEW.organization_id
              AND claim.artifact_id = NEW.artifact_id
          ))
      )
      AND (
        (
          OLD.state = 'intent' AND NEW.state = 'eligible'
          AND OLD.proof_sha256 IS NULL
          AND NEW.proof_sha256 = NEW.expected_claim_set_sha256
          AND NEW.bytes_deleted_at IS NULL
        ) OR (
          OLD.state = 'eligible' AND NEW.state = 'deleted'
          AND OLD.proof_sha256 = OLD.expected_claim_set_sha256
          AND NEW.proof_sha256 IS NOT DISTINCT FROM OLD.proof_sha256
          AND NEW.bytes_deleted_at IS NOT NULL
        )
      )
    ) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;

  IF v_capability = 'release_hold'
    AND TG_TABLE_NAME IN (
      'snapshot_reference_claims',
      'evidence_reference_claims',
      'artifact_reference_claims'
    )
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
  END IF;

  IF v_capability = 'purge' AND (
    (
      TG_TABLE_NAME IN (
        'dashboard_versions', 'dashboard_version_snapshots',
        'dashboard_version_evidence'
      )
      AND OLD.dashboard_id IS NOT DISTINCT FROM v_dashboard_id
    ) OR (
      TG_TABLE_NAME = 'dashboard_restore_lineage'
      AND OLD.dashboard_id IS NOT DISTINCT FROM v_dashboard_id
    ) OR (
      TG_TABLE_NAME IN (
        'snapshot_reference_claims',
        'evidence_reference_claims',
        'artifact_reference_claims'
      )
      AND OLD.dashboard_id IS NOT DISTINCT FROM v_dashboard_id
      AND OLD.claim_kind = 'access_bearing'
      AND OLD.hold_id IS NULL
    ) OR (
      TG_TABLE_NAME = 'source_snapshots'
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
            || uuid_send(finalizer.snapshot_id) || convert_to('snapshot|expected_claim_set=empty', 'UTF8')
          )
      )
    ) OR (
      TG_TABLE_NAME = 'evidence_records'
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
            || uuid_send(finalizer.evidence_id) || convert_to('evidence|expected_claim_set=empty', 'UTF8')
          )
      )
    ) OR (
      TG_TABLE_NAME = 'dashboard_artifacts'
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
            || uuid_send(finalizer.artifact_id) || convert_to('artifact|expected_claim_set=empty', 'UTF8')
          )
      )
    )
  ) THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
END
$function$;

ALTER FUNCTION dasher_api.list_dashboards(integer) OWNER TO dasher_security_definer;
REVOKE ALL ON FUNCTION dasher_api.list_dashboards(integer) FROM PUBLIC, dasher_app, dasher_retention_definer, dasher_retention_operator;
GRANT EXECUTE ON FUNCTION dasher_api.list_dashboards(integer) TO dasher_app;
ALTER FUNCTION dasher_api.get_dashboard_summary(uuid) OWNER TO dasher_security_definer;
REVOKE ALL ON FUNCTION dasher_api.get_dashboard_summary(uuid) FROM PUBLIC, dasher_app, dasher_retention_definer, dasher_retention_operator;
GRANT EXECUTE ON FUNCTION dasher_api.get_dashboard_summary(uuid) TO dasher_app;
ALTER FUNCTION dasher_api.get_dashboard_head(uuid) OWNER TO dasher_security_definer;
REVOKE ALL ON FUNCTION dasher_api.get_dashboard_head(uuid) FROM PUBLIC, dasher_app, dasher_retention_definer, dasher_retention_operator;
GRANT EXECUTE ON FUNCTION dasher_api.get_dashboard_head(uuid) TO dasher_app;
ALTER FUNCTION dasher_api.get_dashboard_version(uuid, uuid) OWNER TO dasher_security_definer;
REVOKE ALL ON FUNCTION dasher_api.get_dashboard_version(uuid, uuid) FROM PUBLIC, dasher_app, dasher_retention_definer, dasher_retention_operator;
GRANT EXECUTE ON FUNCTION dasher_api.get_dashboard_version(uuid, uuid) TO dasher_app;
ALTER FUNCTION dasher_api.get_dashboard_evidence(uuid, uuid) OWNER TO dasher_security_definer;
REVOKE ALL ON FUNCTION dasher_api.get_dashboard_evidence(uuid, uuid) FROM PUBLIC, dasher_app, dasher_retention_definer, dasher_retention_operator;
GRANT EXECUTE ON FUNCTION dasher_api.get_dashboard_evidence(uuid, uuid) TO dasher_app;
ALTER FUNCTION dasher_api.get_dashboard_lineage(uuid, uuid) OWNER TO dasher_security_definer;
REVOKE ALL ON FUNCTION dasher_api.get_dashboard_lineage(uuid, uuid) FROM PUBLIC, dasher_app, dasher_retention_definer, dasher_retention_operator;
GRANT EXECUTE ON FUNCTION dasher_api.get_dashboard_lineage(uuid, uuid) TO dasher_app;
ALTER FUNCTION dasher_api.get_dashboard_admin_status(uuid) OWNER TO dasher_security_definer;
REVOKE ALL ON FUNCTION dasher_api.get_dashboard_admin_status(uuid) FROM PUBLIC, dasher_app, dasher_retention_definer, dasher_retention_operator;
GRANT EXECUTE ON FUNCTION dasher_api.get_dashboard_admin_status(uuid) TO dasher_app;
ALTER FUNCTION dasher_api.create_dashboard(uuid, text, text, integer, boolean, uuid, uuid, text) OWNER TO dasher_security_definer;
REVOKE ALL ON FUNCTION dasher_api.create_dashboard(uuid, text, text, integer, boolean, uuid, uuid, text) FROM PUBLIC, dasher_app, dasher_retention_definer, dasher_retention_operator;
GRANT EXECUTE ON FUNCTION dasher_api.create_dashboard(uuid, text, text, integer, boolean, uuid, uuid, text) TO dasher_app;
ALTER FUNCTION dasher_api.create_evidence_record(uuid, uuid, uuid, uuid, uuid, text, text, bytea, timestamptz, timestamptz, uuid, text) OWNER TO dasher_security_definer;
REVOKE ALL ON FUNCTION dasher_api.create_evidence_record(uuid, uuid, uuid, uuid, uuid, text, text, bytea, timestamptz, timestamptz, uuid, text) FROM PUBLIC, dasher_app, dasher_retention_definer, dasher_retention_operator;
GRANT EXECUTE ON FUNCTION dasher_api.create_evidence_record(uuid, uuid, uuid, uuid, uuid, text, text, bytea, timestamptz, timestamptz, uuid, text) TO dasher_app;
ALTER FUNCTION dasher_api.create_dashboard_version(uuid, uuid, uuid, bytea, bytea, bytea, bytea, bigint, bigint, bytea, uuid[], uuid[], uuid[], uuid[], uuid, text) OWNER TO dasher_security_definer;
REVOKE ALL ON FUNCTION dasher_api.create_dashboard_version(uuid, uuid, uuid, bytea, bytea, bytea, bytea, bigint, bigint, bytea, uuid[], uuid[], uuid[], uuid[], uuid, text) FROM PUBLIC, dasher_app, dasher_retention_definer, dasher_retention_operator;
GRANT EXECUTE ON FUNCTION dasher_api.create_dashboard_version(uuid, uuid, uuid, bytea, bytea, bytea, bytea, bigint, bigint, bytea, uuid[], uuid[], uuid[], uuid[], uuid, text) TO dasher_app;
ALTER FUNCTION dasher_api.compare_and_swap_dashboard_head(uuid, uuid, uuid, bigint, uuid, text) OWNER TO dasher_security_definer;
REVOKE ALL ON FUNCTION dasher_api.compare_and_swap_dashboard_head(uuid, uuid, uuid, bigint, uuid, text) FROM PUBLIC, dasher_app, dasher_retention_definer, dasher_retention_operator;
GRANT EXECUTE ON FUNCTION dasher_api.compare_and_swap_dashboard_head(uuid, uuid, uuid, bigint, uuid, text) TO dasher_app;
ALTER FUNCTION dasher_api.request_dashboard_promotion(uuid, uuid, bigint, bytea, uuid, text) OWNER TO dasher_security_definer;
REVOKE ALL ON FUNCTION dasher_api.request_dashboard_promotion(uuid, uuid, bigint, bytea, uuid, text) FROM PUBLIC, dasher_app, dasher_retention_definer, dasher_retention_operator;
GRANT EXECUTE ON FUNCTION dasher_api.request_dashboard_promotion(uuid, uuid, bigint, bytea, uuid, text) TO dasher_app;
ALTER FUNCTION dasher_api.decide_dashboard_promotion(uuid, bigint, text, uuid, uuid, text) OWNER TO dasher_security_definer;
REVOKE ALL ON FUNCTION dasher_api.decide_dashboard_promotion(uuid, bigint, text, uuid, uuid, text) FROM PUBLIC, dasher_app, dasher_retention_definer, dasher_retention_operator;
GRANT EXECUTE ON FUNCTION dasher_api.decide_dashboard_promotion(uuid, bigint, text, uuid, uuid, text) TO dasher_app;
ALTER FUNCTION dasher_api.set_dashboard_archive(uuid, boolean, bigint, uuid, text) OWNER TO dasher_security_definer;
REVOKE ALL ON FUNCTION dasher_api.set_dashboard_archive(uuid, boolean, bigint, uuid, text) FROM PUBLIC, dasher_app, dasher_retention_definer, dasher_retention_operator;
GRANT EXECUTE ON FUNCTION dasher_api.set_dashboard_archive(uuid, boolean, bigint, uuid, text) TO dasher_app;
ALTER FUNCTION dasher_api.delete_dashboard(uuid, bigint, uuid, text) OWNER TO dasher_security_definer;
REVOKE ALL ON FUNCTION dasher_api.delete_dashboard(uuid, bigint, uuid, text) FROM PUBLIC, dasher_app, dasher_retention_definer, dasher_retention_operator;
GRANT EXECUTE ON FUNCTION dasher_api.delete_dashboard(uuid, bigint, uuid, text) TO dasher_app;
ALTER FUNCTION dasher_api.restore_dashboard_as_new(uuid, uuid, bigint, uuid, uuid, uuid, text, bytea, uuid, text) OWNER TO dasher_security_definer;
REVOKE ALL ON FUNCTION dasher_api.restore_dashboard_as_new(uuid, uuid, bigint, uuid, uuid, uuid, text, bytea, uuid, text) FROM PUBLIC, dasher_app, dasher_retention_definer, dasher_retention_operator;
GRANT EXECUTE ON FUNCTION dasher_api.restore_dashboard_as_new(uuid, uuid, bigint, uuid, uuid, uuid, text, bytea, uuid, text) TO dasher_app;
ALTER FUNCTION dasher_retention_api.initialize_operator_context(uuid, text, uuid, text, uuid) OWNER TO dasher_retention_definer;
REVOKE ALL ON FUNCTION dasher_retention_api.initialize_operator_context(uuid, text, uuid, text, uuid) FROM PUBLIC, dasher_app, dasher_security_definer, dasher_retention_operator;
ALTER FUNCTION dasher_retention_api.materialize_dashboard_expiry(uuid, bigint, uuid, text, uuid) OWNER TO dasher_retention_definer;
REVOKE ALL ON FUNCTION dasher_retention_api.materialize_dashboard_expiry(uuid, bigint, uuid, text, uuid) FROM PUBLIC, dasher_app, dasher_security_definer, dasher_retention_operator;
GRANT EXECUTE ON FUNCTION dasher_retention_api.materialize_dashboard_expiry(uuid, bigint, uuid, text, uuid) TO dasher_retention_operator;
ALTER FUNCTION dasher_retention_api.place_dashboard_legal_hold(uuid, uuid, text, bytea, bigint, uuid, text, uuid) OWNER TO dasher_retention_definer;
REVOKE ALL ON FUNCTION dasher_retention_api.place_dashboard_legal_hold(uuid, uuid, text, bytea, bigint, uuid, text, uuid) FROM PUBLIC, dasher_app, dasher_security_definer, dasher_retention_operator;
GRANT EXECUTE ON FUNCTION dasher_retention_api.place_dashboard_legal_hold(uuid, uuid, text, bytea, bigint, uuid, text, uuid) TO dasher_retention_operator;
ALTER FUNCTION dasher_retention_api.release_dashboard_legal_hold(uuid, uuid, bytea, bigint, uuid, text, uuid) OWNER TO dasher_retention_definer;
REVOKE ALL ON FUNCTION dasher_retention_api.release_dashboard_legal_hold(uuid, uuid, bytea, bigint, uuid, text, uuid) FROM PUBLIC, dasher_app, dasher_security_definer, dasher_retention_operator;
GRANT EXECUTE ON FUNCTION dasher_retention_api.release_dashboard_legal_hold(uuid, uuid, bytea, bigint, uuid, text, uuid) TO dasher_retention_operator;
ALTER FUNCTION dasher_retention_api.claim_dashboard_cleanup(uuid, bigint, bytea, interval, uuid, text, uuid) OWNER TO dasher_retention_definer;
REVOKE ALL ON FUNCTION dasher_retention_api.claim_dashboard_cleanup(uuid, bigint, bytea, interval, uuid, text, uuid) FROM PUBLIC, dasher_app, dasher_security_definer, dasher_retention_operator;
GRANT EXECUTE ON FUNCTION dasher_retention_api.claim_dashboard_cleanup(uuid, bigint, bytea, interval, uuid, text, uuid) TO dasher_retention_operator;
ALTER FUNCTION dasher_retention_api.record_dashboard_cleanup_attempt(uuid, uuid, text, text, integer, integer, integer, bytea, uuid) OWNER TO dasher_retention_definer;
REVOKE ALL ON FUNCTION dasher_retention_api.record_dashboard_cleanup_attempt(uuid, uuid, text, text, integer, integer, integer, bytea, uuid) FROM PUBLIC, dasher_app, dasher_security_definer, dasher_retention_operator;
GRANT EXECUTE ON FUNCTION dasher_retention_api.record_dashboard_cleanup_attempt(uuid, uuid, text, text, integer, integer, integer, bytea, uuid) TO dasher_retention_operator;
ALTER FUNCTION dasher_retention_api.purge_dashboard(uuid, bigint, bytea, uuid, text, uuid) OWNER TO dasher_retention_definer;
REVOKE ALL ON FUNCTION dasher_retention_api.purge_dashboard(uuid, bigint, bytea, uuid, text, uuid) FROM PUBLIC, dasher_app, dasher_security_definer, dasher_retention_operator;
GRANT EXECUTE ON FUNCTION dasher_retention_api.purge_dashboard(uuid, bigint, bytea, uuid, text, uuid) TO dasher_retention_operator;
REVOKE ALL ON FUNCTION dasher_private.reject_dashboard_append_mutation() FROM PUBLIC, dasher_app, dasher_security_definer, dasher_retention_definer, dasher_retention_operator;
REVOKE ALL ON FUNCTION dasher_private.enforce_dashboard_transition() FROM PUBLIC, dasher_app, dasher_security_definer, dasher_retention_definer, dasher_retention_operator;
REVOKE ALL ON FUNCTION dasher_private.enforce_retention_mutation() FROM PUBLIC, dasher_app, dasher_security_definer, dasher_retention_definer, dasher_retention_operator;

CREATE TRIGGER dashboard_lifecycle_policies_immutable BEFORE UPDATE OR DELETE ON dasher.dashboard_lifecycle_policies FOR EACH ROW EXECUTE FUNCTION dasher_private.reject_dashboard_append_mutation();
CREATE TRIGGER dashboard_lifecycle_events_immutable BEFORE UPDATE OR DELETE ON dasher.dashboard_lifecycle_events FOR EACH ROW EXECUTE FUNCTION dasher_private.reject_dashboard_append_mutation();
CREATE TRIGGER dashboard_promotion_requests_immutable BEFORE UPDATE OR DELETE ON dasher.dashboard_promotion_requests FOR EACH ROW EXECUTE FUNCTION dasher_private.reject_dashboard_append_mutation();
CREATE TRIGGER dashboard_promotion_decisions_immutable BEFORE UPDATE OR DELETE ON dasher.dashboard_promotion_decisions FOR EACH ROW EXECUTE FUNCTION dasher_private.reject_dashboard_append_mutation();
CREATE TRIGGER dashboard_cleanup_attempts_immutable BEFORE UPDATE OR DELETE ON dasher.dashboard_cleanup_attempts FOR EACH ROW EXECUTE FUNCTION dasher_private.reject_dashboard_append_mutation();
CREATE TRIGGER dashboard_restore_lineage_immutable BEFORE UPDATE OR DELETE ON dasher.dashboard_restore_lineage FOR EACH ROW EXECUTE FUNCTION dasher_private.enforce_retention_mutation();
CREATE TRIGGER backup_deletion_ledger_immutable BEFORE UPDATE OR DELETE ON dasher.backup_deletion_ledger FOR EACH ROW EXECUTE FUNCTION dasher_private.reject_dashboard_append_mutation();
CREATE TRIGGER retention_service_principal_allowlist_immutable BEFORE UPDATE OR DELETE ON dasher.retention_service_principal_allowlist FOR EACH ROW EXECUTE FUNCTION dasher_private.reject_dashboard_append_mutation();
CREATE TRIGGER dashboards_transition_guard BEFORE UPDATE ON dasher.dashboards FOR EACH ROW EXECUTE FUNCTION dasher_private.enforce_dashboard_transition();
CREATE TRIGGER dashboard_legal_holds_retention_guard BEFORE UPDATE ON dasher.dashboard_legal_holds FOR EACH ROW EXECUTE FUNCTION dasher_private.enforce_retention_mutation();
CREATE TRIGGER dashboard_tombstones_retention_guard BEFORE UPDATE OR DELETE ON dasher.dashboard_tombstones FOR EACH ROW EXECUTE FUNCTION dasher_private.enforce_retention_mutation();
CREATE TRIGGER source_snapshots_retention_guard BEFORE UPDATE OR DELETE ON dasher.source_snapshots FOR EACH ROW EXECUTE FUNCTION dasher_private.enforce_retention_mutation();
CREATE TRIGGER evidence_records_retention_guard BEFORE UPDATE OR DELETE ON dasher.evidence_records FOR EACH ROW EXECUTE FUNCTION dasher_private.enforce_retention_mutation();
CREATE TRIGGER dashboard_versions_retention_guard BEFORE UPDATE OR DELETE ON dasher.dashboard_versions FOR EACH ROW EXECUTE FUNCTION dasher_private.enforce_retention_mutation();
CREATE TRIGGER dashboard_version_snapshots_retention_guard BEFORE UPDATE OR DELETE ON dasher.dashboard_version_snapshots FOR EACH ROW EXECUTE FUNCTION dasher_private.enforce_retention_mutation();
CREATE TRIGGER dashboard_version_evidence_retention_guard BEFORE UPDATE OR DELETE ON dasher.dashboard_version_evidence FOR EACH ROW EXECUTE FUNCTION dasher_private.enforce_retention_mutation();
CREATE TRIGGER dashboard_artifacts_retention_guard BEFORE UPDATE OR DELETE ON dasher.dashboard_artifacts FOR EACH ROW EXECUTE FUNCTION dasher_private.enforce_retention_mutation();
CREATE TRIGGER snapshot_reference_claims_retention_guard BEFORE UPDATE OR DELETE ON dasher.snapshot_reference_claims FOR EACH ROW EXECUTE FUNCTION dasher_private.enforce_retention_mutation();
CREATE TRIGGER evidence_reference_claims_retention_guard BEFORE UPDATE OR DELETE ON dasher.evidence_reference_claims FOR EACH ROW EXECUTE FUNCTION dasher_private.enforce_retention_mutation();
CREATE TRIGGER artifact_reference_claims_retention_guard BEFORE UPDATE OR DELETE ON dasher.artifact_reference_claims FOR EACH ROW EXECUTE FUNCTION dasher_private.enforce_retention_mutation();
CREATE TRIGGER snapshot_deletion_finalizers_retention_guard BEFORE UPDATE OR DELETE ON dasher.snapshot_deletion_finalizers FOR EACH ROW EXECUTE FUNCTION dasher_private.enforce_retention_mutation();
CREATE TRIGGER evidence_deletion_finalizers_retention_guard BEFORE UPDATE OR DELETE ON dasher.evidence_deletion_finalizers FOR EACH ROW EXECUTE FUNCTION dasher_private.enforce_retention_mutation();
CREATE TRIGGER artifact_deletion_finalizers_retention_guard BEFORE UPDATE OR DELETE ON dasher.artifact_deletion_finalizers FOR EACH ROW EXECUTE FUNCTION dasher_private.enforce_retention_mutation();

CREATE POLICY retention_service_principal_self_binding_select
ON dasher.retention_service_principal_allowlist
AS PERMISSIVE
FOR SELECT
TO dasher_retention_definer
USING (((CURRENT_USER = 'dasher_retention_definer'::name) AND (binding_kind = 'postgres_session_user'::text) AND (binding_subject = SESSION_USER)))
;
CREATE POLICY dashboards_retention_target_discovery_select
ON dasher.dashboards
AS PERMISSIVE
FOR SELECT
TO dasher_retention_definer
USING (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'target_discovery'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['materialize_expiry'::text, 'place_hold'::text, 'release_hold'::text, 'claim_cleanup'::text, 'record_attempt'::text, 'purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)))
;
CREATE POLICY dashboard_lifecycle_policies_retention_select
ON dasher.dashboard_lifecycle_policies
AS PERMISSIVE
FOR SELECT
TO dasher_retention_definer
USING (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['materialize_expiry'::text, 'place_hold'::text, 'release_hold'::text, 'claim_cleanup'::text, 'record_attempt'::text, 'purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid)))
;
CREATE POLICY dashboards_retention_select
ON dasher.dashboards
AS PERMISSIVE
FOR SELECT
TO dasher_retention_definer
USING (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['materialize_expiry'::text, 'place_hold'::text, 'release_hold'::text, 'claim_cleanup'::text, 'record_attempt'::text, 'purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)))
;
CREATE POLICY dashboards_retention_update
ON dasher.dashboards
AS PERMISSIVE
FOR UPDATE
TO dasher_retention_definer
USING (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['materialize_expiry'::text, 'place_hold'::text, 'release_hold'::text, 'claim_cleanup'::text, 'purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)))
WITH CHECK (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['materialize_expiry'::text, 'place_hold'::text, 'release_hold'::text, 'claim_cleanup'::text, 'purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)))
;
CREATE POLICY dashboard_lifecycle_events_retention_insert
ON dasher.dashboard_lifecycle_events
AS PERMISSIVE
FOR INSERT
TO dasher_retention_definer
WITH CHECK (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['materialize_expiry'::text, 'place_hold'::text, 'release_hold'::text, 'claim_cleanup'::text, 'purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)))
;
CREATE POLICY dashboard_cleanup_coordination_retention_select
ON dasher.dashboard_cleanup_coordination
AS PERMISSIVE
FOR SELECT
TO dasher_retention_definer
USING (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['materialize_expiry'::text, 'claim_cleanup'::text, 'record_attempt'::text, 'purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)))
;
CREATE POLICY dashboard_cleanup_coordination_retention_insert
ON dasher.dashboard_cleanup_coordination
AS PERMISSIVE
FOR INSERT
TO dasher_retention_definer
WITH CHECK (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['materialize_expiry'::text, 'claim_cleanup'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)))
;
CREATE POLICY dashboard_cleanup_coordination_retention_update
ON dasher.dashboard_cleanup_coordination
AS PERMISSIVE
FOR UPDATE
TO dasher_retention_definer
USING (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['claim_cleanup'::text, 'record_attempt'::text, 'purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)))
WITH CHECK (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['claim_cleanup'::text, 'record_attempt'::text, 'purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)))
;
CREATE POLICY dashboard_cleanup_attempts_retention_select
ON dasher.dashboard_cleanup_attempts
AS PERMISSIVE
FOR SELECT
TO dasher_retention_definer
USING (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['record_attempt'::text, 'purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)))
;
CREATE POLICY dashboard_cleanup_attempts_retention_insert
ON dasher.dashboard_cleanup_attempts
AS PERMISSIVE
FOR INSERT
TO dasher_retention_definer
WITH CHECK (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['record_attempt'::text, 'purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)))
;
CREATE POLICY dashboard_legal_holds_retention_select
ON dasher.dashboard_legal_holds
AS PERMISSIVE
FOR SELECT
TO dasher_retention_definer
USING (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['place_hold'::text, 'release_hold'::text, 'claim_cleanup'::text, 'purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)))
;
CREATE POLICY dashboard_legal_holds_retention_insert
ON dasher.dashboard_legal_holds
AS PERMISSIVE
FOR INSERT
TO dasher_retention_definer
WITH CHECK (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['place_hold'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)))
;
CREATE POLICY dashboard_legal_holds_retention_update
ON dasher.dashboard_legal_holds
AS PERMISSIVE
FOR UPDATE
TO dasher_retention_definer
USING (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['release_hold'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)))
WITH CHECK (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['release_hold'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)))
;
CREATE POLICY dashboard_tombstones_retention_select
ON dasher.dashboard_tombstones
AS PERMISSIVE
FOR SELECT
TO dasher_retention_definer
USING (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['materialize_expiry'::text, 'purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND EXISTS (SELECT 1 FROM dasher.dashboards AS target WHERE target.organization_id = dashboard_tombstones.organization_id AND target.dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid AND target.tombstone_lineage_id = dashboard_tombstones.tombstone_lineage_id)))
;
CREATE POLICY dashboard_tombstones_retention_insert
ON dasher.dashboard_tombstones
AS PERMISSIVE
FOR INSERT
TO dasher_retention_definer
WITH CHECK (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['materialize_expiry'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND EXISTS (SELECT 1 FROM dasher.dashboards AS target WHERE target.organization_id = dashboard_tombstones.organization_id AND target.dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid AND target.tombstone_lineage_id = dashboard_tombstones.tombstone_lineage_id)))
;
CREATE POLICY dashboard_tombstones_retention_update
ON dasher.dashboard_tombstones
AS PERMISSIVE
FOR UPDATE
TO dasher_retention_definer
USING (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND EXISTS (SELECT 1 FROM dasher.dashboards AS target WHERE target.organization_id = dashboard_tombstones.organization_id AND target.dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid AND target.tombstone_lineage_id = dashboard_tombstones.tombstone_lineage_id)))
WITH CHECK (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND EXISTS (SELECT 1 FROM dasher.dashboards AS target WHERE target.organization_id = dashboard_tombstones.organization_id AND target.dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid AND target.tombstone_lineage_id = dashboard_tombstones.tombstone_lineage_id)))
;
CREATE POLICY backup_deletion_ledger_retention_select
ON dasher.backup_deletion_ledger
AS PERMISSIVE
FOR SELECT
TO dasher_retention_definer
USING (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['materialize_expiry'::text, 'purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND EXISTS (SELECT 1 FROM dasher.dashboards AS target WHERE target.organization_id = backup_deletion_ledger.organization_id AND target.dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid AND target.tombstone_lineage_id = backup_deletion_ledger.tombstone_lineage_id)))
;
CREATE POLICY backup_deletion_ledger_retention_insert
ON dasher.backup_deletion_ledger
AS PERMISSIVE
FOR INSERT
TO dasher_retention_definer
WITH CHECK (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['materialize_expiry'::text, 'purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND EXISTS (SELECT 1 FROM dasher.dashboards AS target WHERE target.organization_id = backup_deletion_ledger.organization_id AND target.dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid AND target.tombstone_lineage_id = backup_deletion_ledger.tombstone_lineage_id)))
;
CREATE POLICY source_snapshots_retention_select
ON dasher.source_snapshots
AS PERMISSIVE
FOR SELECT
TO dasher_retention_definer
USING (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (EXISTS (SELECT 1 FROM dasher.snapshot_reference_claims AS target_claim WHERE target_claim.organization_id = source_snapshots.organization_id AND target_claim.snapshot_id = source_snapshots.snapshot_id AND target_claim.dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid) OR EXISTS (SELECT 1 FROM dasher.snapshot_deletion_finalizers AS target_finalizer JOIN dasher.dashboard_cleanup_coordination AS target_cleanup ON target_cleanup.organization_id = target_finalizer.organization_id AND target_cleanup.dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid AND target_cleanup.completion_proof_sha256 = target_finalizer.expected_claim_set_sha256 WHERE target_finalizer.organization_id = source_snapshots.organization_id AND target_finalizer.snapshot_id = source_snapshots.snapshot_id))))
;
CREATE POLICY source_snapshots_retention_delete
ON dasher.source_snapshots
AS PERMISSIVE
FOR DELETE
TO dasher_retention_definer
USING (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (EXISTS (SELECT 1 FROM dasher.snapshot_reference_claims AS target_claim WHERE target_claim.organization_id = source_snapshots.organization_id AND target_claim.snapshot_id = source_snapshots.snapshot_id AND target_claim.dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid) OR EXISTS (SELECT 1 FROM dasher.snapshot_deletion_finalizers AS target_finalizer JOIN dasher.dashboard_cleanup_coordination AS target_cleanup ON target_cleanup.organization_id = target_finalizer.organization_id AND target_cleanup.dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid AND target_cleanup.completion_proof_sha256 = target_finalizer.expected_claim_set_sha256 WHERE target_finalizer.organization_id = source_snapshots.organization_id AND target_finalizer.snapshot_id = source_snapshots.snapshot_id))))
;
CREATE POLICY evidence_records_retention_select
ON dasher.evidence_records
AS PERMISSIVE
FOR SELECT
TO dasher_retention_definer
USING (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (EXISTS (SELECT 1 FROM dasher.evidence_reference_claims AS target_claim WHERE target_claim.organization_id = evidence_records.organization_id AND target_claim.evidence_id = evidence_records.evidence_id AND target_claim.dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid) OR EXISTS (SELECT 1 FROM dasher.evidence_deletion_finalizers AS target_finalizer JOIN dasher.dashboard_cleanup_coordination AS target_cleanup ON target_cleanup.organization_id = target_finalizer.organization_id AND target_cleanup.dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid AND target_cleanup.completion_proof_sha256 = target_finalizer.expected_claim_set_sha256 WHERE target_finalizer.organization_id = evidence_records.organization_id AND target_finalizer.evidence_id = evidence_records.evidence_id))))
;
CREATE POLICY evidence_records_retention_delete
ON dasher.evidence_records
AS PERMISSIVE
FOR DELETE
TO dasher_retention_definer
USING (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (EXISTS (SELECT 1 FROM dasher.evidence_reference_claims AS target_claim WHERE target_claim.organization_id = evidence_records.organization_id AND target_claim.evidence_id = evidence_records.evidence_id AND target_claim.dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid) OR EXISTS (SELECT 1 FROM dasher.evidence_deletion_finalizers AS target_finalizer JOIN dasher.dashboard_cleanup_coordination AS target_cleanup ON target_cleanup.organization_id = target_finalizer.organization_id AND target_cleanup.dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid AND target_cleanup.completion_proof_sha256 = target_finalizer.expected_claim_set_sha256 WHERE target_finalizer.organization_id = evidence_records.organization_id AND target_finalizer.evidence_id = evidence_records.evidence_id))))
;
CREATE POLICY dashboard_versions_retention_select
ON dasher.dashboard_versions
AS PERMISSIVE
FOR SELECT
TO dasher_retention_definer
USING (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['place_hold'::text, 'purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)))
;
CREATE POLICY dashboard_versions_retention_delete
ON dasher.dashboard_versions
AS PERMISSIVE
FOR DELETE
TO dasher_retention_definer
USING (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)))
;
CREATE POLICY dashboard_version_snapshots_retention_select
ON dasher.dashboard_version_snapshots
AS PERMISSIVE
FOR SELECT
TO dasher_retention_definer
USING (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['place_hold'::text, 'purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)))
;
CREATE POLICY dashboard_version_snapshots_retention_delete
ON dasher.dashboard_version_snapshots
AS PERMISSIVE
FOR DELETE
TO dasher_retention_definer
USING (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)))
;
CREATE POLICY dashboard_version_evidence_retention_select
ON dasher.dashboard_version_evidence
AS PERMISSIVE
FOR SELECT
TO dasher_retention_definer
USING (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['place_hold'::text, 'purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)))
;
CREATE POLICY dashboard_version_evidence_retention_delete
ON dasher.dashboard_version_evidence
AS PERMISSIVE
FOR DELETE
TO dasher_retention_definer
USING (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)))
;
CREATE POLICY dashboard_artifacts_retention_select
ON dasher.dashboard_artifacts
AS PERMISSIVE
FOR SELECT
TO dasher_retention_definer
USING (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['place_hold'::text, 'purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (((ownership_class = 'dashboard_owned'::text) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)) OR ((ownership_class = 'shared'::text) AND ((EXISTS (SELECT 1 FROM dasher.artifact_reference_claims AS target_claim WHERE target_claim.organization_id = dashboard_artifacts.organization_id AND target_claim.artifact_id = dashboard_artifacts.artifact_id AND target_claim.dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid AND target_claim.claim_kind = 'access_bearing'::text AND target_claim.hold_id IS NULL)) OR (EXISTS (SELECT 1 FROM dasher.artifact_deletion_finalizers AS target_finalizer WHERE target_finalizer.organization_id = dashboard_artifacts.organization_id AND target_finalizer.artifact_id = dashboard_artifacts.artifact_id AND target_finalizer.state = ANY (ARRAY['intent'::text, 'eligible'::text, 'deleted'::text]) AND target_finalizer.expected_claim_set_sha256 = sha256(uuid_send((current_setting('dasher.retention_target_organization_id'::text, true))::uuid) || uuid_send((current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid) || uuid_send(target_finalizer.artifact_id) || convert_to('artifact|expected_claim_set=empty'::text, 'UTF8'::name)))))))))
;
CREATE POLICY dashboard_artifacts_retention_delete
ON dasher.dashboard_artifacts
AS PERMISSIVE
FOR DELETE
TO dasher_retention_definer
USING (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (((ownership_class = 'dashboard_owned'::text) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)) OR ((ownership_class = 'shared'::text) AND (EXISTS (SELECT 1 FROM dasher.artifact_deletion_finalizers AS target_finalizer WHERE target_finalizer.organization_id = dashboard_artifacts.organization_id AND target_finalizer.artifact_id = dashboard_artifacts.artifact_id AND target_finalizer.state = 'deleted'::text AND target_finalizer.proof_sha256 IS NOT NULL AND target_finalizer.bytes_deleted_at IS NOT NULL AND target_finalizer.expected_claim_set_sha256 = sha256(uuid_send((current_setting('dasher.retention_target_organization_id'::text, true))::uuid) || uuid_send((current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid) || uuid_send(target_finalizer.artifact_id) || convert_to('artifact|expected_claim_set=empty'::text, 'UTF8'::name))))))))
;
CREATE POLICY snapshot_reference_claims_retention_select
ON dasher.snapshot_reference_claims
AS PERMISSIVE
FOR SELECT
TO dasher_retention_definer
USING (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['place_hold'::text, 'release_hold'::text, 'claim_cleanup'::text, 'purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)))
;
CREATE POLICY snapshot_reference_claims_retention_insert
ON dasher.snapshot_reference_claims
AS PERMISSIVE
FOR INSERT
TO dasher_retention_definer
WITH CHECK (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['place_hold'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)))
;
CREATE POLICY snapshot_reference_claims_retention_delete
ON dasher.snapshot_reference_claims
AS PERMISSIVE
FOR DELETE
TO dasher_retention_definer
USING (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['release_hold'::text, 'purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)))
;
CREATE POLICY evidence_reference_claims_retention_select
ON dasher.evidence_reference_claims
AS PERMISSIVE
FOR SELECT
TO dasher_retention_definer
USING (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['place_hold'::text, 'release_hold'::text, 'claim_cleanup'::text, 'purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)))
;
CREATE POLICY evidence_reference_claims_retention_insert
ON dasher.evidence_reference_claims
AS PERMISSIVE
FOR INSERT
TO dasher_retention_definer
WITH CHECK (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['place_hold'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)))
;
CREATE POLICY evidence_reference_claims_retention_delete
ON dasher.evidence_reference_claims
AS PERMISSIVE
FOR DELETE
TO dasher_retention_definer
USING (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['release_hold'::text, 'purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)))
;
CREATE POLICY artifact_reference_claims_retention_select
ON dasher.artifact_reference_claims
AS PERMISSIVE
FOR SELECT
TO dasher_retention_definer
USING (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['place_hold'::text, 'release_hold'::text, 'claim_cleanup'::text, 'purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)))
;
CREATE POLICY artifact_reference_claims_retention_insert
ON dasher.artifact_reference_claims
AS PERMISSIVE
FOR INSERT
TO dasher_retention_definer
WITH CHECK (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['place_hold'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)))
;
CREATE POLICY artifact_reference_claims_retention_delete
ON dasher.artifact_reference_claims
AS PERMISSIVE
FOR DELETE
TO dasher_retention_definer
USING (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['release_hold'::text, 'purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)))
;
CREATE POLICY snapshot_deletion_finalizers_security_select
ON dasher.snapshot_deletion_finalizers
AS PERMISSIVE
FOR SELECT
TO dasher_security_definer
USING (((CURRENT_USER = 'dasher_security_definer'::name) AND (organization_id = dasher_private.context_organization_id())))
;
CREATE POLICY snapshot_deletion_finalizers_retention_select
ON dasher.snapshot_deletion_finalizers
AS PERMISSIVE
FOR SELECT
TO dasher_retention_definer
USING (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (expected_claim_set_sha256 = sha256((((uuid_send((current_setting('dasher.retention_target_organization_id'::text, true))::uuid) || uuid_send((current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)) || uuid_send(snapshot_id)) || convert_to('snapshot|expected_claim_set=empty'::text, 'UTF8'::name))))))
;
CREATE POLICY snapshot_deletion_finalizers_retention_insert
ON dasher.snapshot_deletion_finalizers
AS PERMISSIVE
FOR INSERT
TO dasher_retention_definer
WITH CHECK (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (expected_claim_set_sha256 = sha256((((uuid_send((current_setting('dasher.retention_target_organization_id'::text, true))::uuid) || uuid_send((current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)) || uuid_send(snapshot_id)) || convert_to('snapshot|expected_claim_set=empty'::text, 'UTF8'::name))))))
;
CREATE POLICY snapshot_deletion_finalizers_retention_update
ON dasher.snapshot_deletion_finalizers
AS PERMISSIVE
FOR UPDATE
TO dasher_retention_definer
USING (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (expected_claim_set_sha256 = sha256((((uuid_send((current_setting('dasher.retention_target_organization_id'::text, true))::uuid) || uuid_send((current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)) || uuid_send(snapshot_id)) || convert_to('snapshot|expected_claim_set=empty'::text, 'UTF8'::name))))))
WITH CHECK (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (expected_claim_set_sha256 = sha256((((uuid_send((current_setting('dasher.retention_target_organization_id'::text, true))::uuid) || uuid_send((current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)) || uuid_send(snapshot_id)) || convert_to('snapshot|expected_claim_set=empty'::text, 'UTF8'::name))))))
;
CREATE POLICY evidence_deletion_finalizers_security_select
ON dasher.evidence_deletion_finalizers
AS PERMISSIVE
FOR SELECT
TO dasher_security_definer
USING (((CURRENT_USER = 'dasher_security_definer'::name) AND (organization_id = dasher_private.context_organization_id())))
;
CREATE POLICY evidence_deletion_finalizers_retention_select
ON dasher.evidence_deletion_finalizers
AS PERMISSIVE
FOR SELECT
TO dasher_retention_definer
USING (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (expected_claim_set_sha256 = sha256((((uuid_send((current_setting('dasher.retention_target_organization_id'::text, true))::uuid) || uuid_send((current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)) || uuid_send(evidence_id)) || convert_to('evidence|expected_claim_set=empty'::text, 'UTF8'::name))))))
;
CREATE POLICY evidence_deletion_finalizers_retention_insert
ON dasher.evidence_deletion_finalizers
AS PERMISSIVE
FOR INSERT
TO dasher_retention_definer
WITH CHECK (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (expected_claim_set_sha256 = sha256((((uuid_send((current_setting('dasher.retention_target_organization_id'::text, true))::uuid) || uuid_send((current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)) || uuid_send(evidence_id)) || convert_to('evidence|expected_claim_set=empty'::text, 'UTF8'::name))))))
;
CREATE POLICY evidence_deletion_finalizers_retention_update
ON dasher.evidence_deletion_finalizers
AS PERMISSIVE
FOR UPDATE
TO dasher_retention_definer
USING (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (expected_claim_set_sha256 = sha256((((uuid_send((current_setting('dasher.retention_target_organization_id'::text, true))::uuid) || uuid_send((current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)) || uuid_send(evidence_id)) || convert_to('evidence|expected_claim_set=empty'::text, 'UTF8'::name))))))
WITH CHECK (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (expected_claim_set_sha256 = sha256((((uuid_send((current_setting('dasher.retention_target_organization_id'::text, true))::uuid) || uuid_send((current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)) || uuid_send(evidence_id)) || convert_to('evidence|expected_claim_set=empty'::text, 'UTF8'::name))))))
;
CREATE POLICY artifact_deletion_finalizers_security_select
ON dasher.artifact_deletion_finalizers
AS PERMISSIVE
FOR SELECT
TO dasher_security_definer
USING (((CURRENT_USER = 'dasher_security_definer'::name) AND (organization_id = dasher_private.context_organization_id())))
;
CREATE POLICY artifact_deletion_finalizers_retention_select
ON dasher.artifact_deletion_finalizers
AS PERMISSIVE
FOR SELECT
TO dasher_retention_definer
USING (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (expected_claim_set_sha256 = sha256((((uuid_send((current_setting('dasher.retention_target_organization_id'::text, true))::uuid) || uuid_send((current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)) || uuid_send(artifact_id)) || convert_to('artifact|expected_claim_set=empty'::text, 'UTF8'::name))))))
;
CREATE POLICY artifact_deletion_finalizers_retention_insert
ON dasher.artifact_deletion_finalizers
AS PERMISSIVE
FOR INSERT
TO dasher_retention_definer
WITH CHECK (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (expected_claim_set_sha256 = sha256((((uuid_send((current_setting('dasher.retention_target_organization_id'::text, true))::uuid) || uuid_send((current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)) || uuid_send(artifact_id)) || convert_to('artifact|expected_claim_set=empty'::text, 'UTF8'::name))))))
;
CREATE POLICY artifact_deletion_finalizers_retention_update
ON dasher.artifact_deletion_finalizers
AS PERMISSIVE
FOR UPDATE
TO dasher_retention_definer
USING (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (expected_claim_set_sha256 = sha256((((uuid_send((current_setting('dasher.retention_target_organization_id'::text, true))::uuid) || uuid_send((current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)) || uuid_send(artifact_id)) || convert_to('artifact|expected_claim_set=empty'::text, 'UTF8'::name))))))
WITH CHECK (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (expected_claim_set_sha256 = sha256((((uuid_send((current_setting('dasher.retention_target_organization_id'::text, true))::uuid) || uuid_send((current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)) || uuid_send(artifact_id)) || convert_to('artifact|expected_claim_set=empty'::text, 'UTF8'::name))))))
;
CREATE POLICY audit_events_retention_insert
ON dasher.audit_events
AS PERMISSIVE
FOR INSERT
TO dasher_retention_definer
WITH CHECK (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['materialize_expiry'::text, 'place_hold'::text, 'release_hold'::text, 'claim_cleanup'::text, 'purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (target_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)))
;
CREATE POLICY dashboard_restore_lineage_retention_select
ON dasher.dashboard_restore_lineage
AS PERMISSIVE
FOR SELECT
TO dasher_retention_definer
USING (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)))
;
CREATE POLICY dashboard_restore_lineage_retention_delete
ON dasher.dashboard_restore_lineage
AS PERMISSIVE
FOR DELETE
TO dasher_retention_definer
USING (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)))
;
CREATE POLICY dashboard_lifecycle_policies_security_lock_update
ON dasher.dashboard_lifecycle_policies
AS PERMISSIVE
FOR UPDATE
TO dasher_security_definer
USING (((CURRENT_USER = 'dasher_security_definer'::name) AND (organization_id = dasher_private.context_organization_id())))
WITH CHECK (((CURRENT_USER = 'dasher_security_definer'::name) AND (organization_id = dasher_private.context_organization_id())))
;
CREATE POLICY dashboards_security_lock_update
ON dasher.dashboards
AS PERMISSIVE
FOR UPDATE
TO dasher_security_definer
USING (((CURRENT_USER = 'dasher_security_definer'::name) AND (organization_id = dasher_private.context_organization_id())))
WITH CHECK (((CURRENT_USER = 'dasher_security_definer'::name) AND (organization_id = dasher_private.context_organization_id())))
;
CREATE POLICY source_snapshots_security_lock_update
ON dasher.source_snapshots
AS PERMISSIVE
FOR UPDATE
TO dasher_security_definer
USING (((CURRENT_USER = 'dasher_security_definer'::name) AND (organization_id = dasher_private.context_organization_id())))
WITH CHECK (((CURRENT_USER = 'dasher_security_definer'::name) AND (organization_id = dasher_private.context_organization_id())))
;
CREATE POLICY dashboard_versions_security_lock_update
ON dasher.dashboard_versions
AS PERMISSIVE
FOR UPDATE
TO dasher_security_definer
USING (((CURRENT_USER = 'dasher_security_definer'::name) AND (organization_id = dasher_private.context_organization_id())))
WITH CHECK (((CURRENT_USER = 'dasher_security_definer'::name) AND (organization_id = dasher_private.context_organization_id())))
;
CREATE POLICY evidence_records_security_lock_update
ON dasher.evidence_records
AS PERMISSIVE
FOR UPDATE
TO dasher_security_definer
USING (((CURRENT_USER = 'dasher_security_definer'::name) AND (organization_id = dasher_private.context_organization_id())))
WITH CHECK (((CURRENT_USER = 'dasher_security_definer'::name) AND (organization_id = dasher_private.context_organization_id())))
;
CREATE POLICY dashboard_promotion_requests_security_lock_update
ON dasher.dashboard_promotion_requests
AS PERMISSIVE
FOR UPDATE
TO dasher_security_definer
USING (((CURRENT_USER = 'dasher_security_definer'::name) AND (organization_id = dasher_private.context_organization_id())))
WITH CHECK (((CURRENT_USER = 'dasher_security_definer'::name) AND (organization_id = dasher_private.context_organization_id())))
;
CREATE POLICY dashboard_tombstones_security_lock_update
ON dasher.dashboard_tombstones
AS PERMISSIVE
FOR UPDATE
TO dasher_security_definer
USING (((CURRENT_USER = 'dasher_security_definer'::name) AND (organization_id = dasher_private.context_organization_id())))
WITH CHECK (((CURRENT_USER = 'dasher_security_definer'::name) AND (organization_id = dasher_private.context_organization_id())))
;
CREATE POLICY dashboard_lifecycle_policies_retention_lock_update
ON dasher.dashboard_lifecycle_policies
AS PERMISSIVE
FOR UPDATE
TO dasher_retention_definer
USING (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['materialize_expiry'::text, 'place_hold'::text, 'release_hold'::text, 'claim_cleanup'::text, 'record_attempt'::text, 'purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND EXISTS (SELECT 1 FROM dasher.dashboards AS target_dashboard WHERE target_dashboard.organization_id = dashboard_lifecycle_policies.organization_id AND target_dashboard.dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid)))
WITH CHECK (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['materialize_expiry'::text, 'place_hold'::text, 'release_hold'::text, 'claim_cleanup'::text, 'record_attempt'::text, 'purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND EXISTS (SELECT 1 FROM dasher.dashboards AS target_dashboard WHERE target_dashboard.organization_id = dashboard_lifecycle_policies.organization_id AND target_dashboard.dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid)))
;
CREATE POLICY dashboards_retention_record_attempt_lock_update
ON dasher.dashboards
AS PERMISSIVE
FOR UPDATE
TO dasher_retention_definer
USING (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['record_attempt'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)))
WITH CHECK (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['record_attempt'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)))
;
CREATE POLICY dashboard_legal_holds_retention_lock_update
ON dasher.dashboard_legal_holds
AS PERMISSIVE
FOR UPDATE
TO dasher_retention_definer
USING (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['claim_cleanup'::text, 'purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)))
WITH CHECK (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['claim_cleanup'::text, 'purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)))
;
CREATE POLICY dashboard_version_snapshots_retention_lock_update
ON dasher.dashboard_version_snapshots
AS PERMISSIVE
FOR UPDATE
TO dasher_retention_definer
USING (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['place_hold'::text, 'purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)))
WITH CHECK (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['place_hold'::text, 'purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)))
;
CREATE POLICY dashboard_version_evidence_retention_lock_update
ON dasher.dashboard_version_evidence
AS PERMISSIVE
FOR UPDATE
TO dasher_retention_definer
USING (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['place_hold'::text, 'purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)))
WITH CHECK (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['place_hold'::text, 'purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)))
;
CREATE POLICY dashboard_artifacts_retention_lock_update
ON dasher.dashboard_artifacts
AS PERMISSIVE
FOR UPDATE
TO dasher_retention_definer
USING (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['place_hold'::text, 'purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (((ownership_class = 'dashboard_owned'::text) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)) OR ((ownership_class = 'shared'::text) AND (EXISTS (SELECT 1 FROM dasher.artifact_reference_claims AS target_claim WHERE target_claim.organization_id = dashboard_artifacts.organization_id AND target_claim.artifact_id = dashboard_artifacts.artifact_id AND target_claim.dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid AND target_claim.claim_kind = 'access_bearing'::text AND target_claim.hold_id IS NULL))))))
WITH CHECK (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['place_hold'::text, 'purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (((ownership_class = 'dashboard_owned'::text) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)) OR ((ownership_class = 'shared'::text) AND (EXISTS (SELECT 1 FROM dasher.artifact_reference_claims AS target_claim WHERE target_claim.organization_id = dashboard_artifacts.organization_id AND target_claim.artifact_id = dashboard_artifacts.artifact_id AND target_claim.dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid AND target_claim.claim_kind = 'access_bearing'::text AND target_claim.hold_id IS NULL))))))
;
CREATE POLICY snapshot_reference_claims_retention_lock_update
ON dasher.snapshot_reference_claims
AS PERMISSIVE
FOR UPDATE
TO dasher_retention_definer
USING (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['release_hold'::text, 'purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)))
WITH CHECK (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['release_hold'::text, 'purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)))
;
CREATE POLICY evidence_reference_claims_retention_lock_update
ON dasher.evidence_reference_claims
AS PERMISSIVE
FOR UPDATE
TO dasher_retention_definer
USING (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['release_hold'::text, 'purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)))
WITH CHECK (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['release_hold'::text, 'purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)))
;
CREATE POLICY artifact_reference_claims_retention_lock_update
ON dasher.artifact_reference_claims
AS PERMISSIVE
FOR UPDATE
TO dasher_retention_definer
USING (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['release_hold'::text, 'purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)))
WITH CHECK (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['release_hold'::text, 'purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)))
;
CREATE POLICY source_snapshots_retention_lock_update
ON dasher.source_snapshots
AS PERMISSIVE
FOR UPDATE
TO dasher_retention_definer
USING (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (EXISTS (SELECT 1 FROM dasher.snapshot_reference_claims AS target_claim WHERE target_claim.organization_id = source_snapshots.organization_id AND target_claim.snapshot_id = source_snapshots.snapshot_id AND target_claim.dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid) OR EXISTS (SELECT 1 FROM dasher.snapshot_deletion_finalizers AS target_finalizer JOIN dasher.dashboard_cleanup_coordination AS target_cleanup ON target_cleanup.organization_id = target_finalizer.organization_id AND target_cleanup.dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid AND target_cleanup.completion_proof_sha256 = target_finalizer.expected_claim_set_sha256 WHERE target_finalizer.organization_id = source_snapshots.organization_id AND target_finalizer.snapshot_id = source_snapshots.snapshot_id))))
WITH CHECK (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (EXISTS (SELECT 1 FROM dasher.snapshot_reference_claims AS target_claim WHERE target_claim.organization_id = source_snapshots.organization_id AND target_claim.snapshot_id = source_snapshots.snapshot_id AND target_claim.dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid) OR EXISTS (SELECT 1 FROM dasher.snapshot_deletion_finalizers AS target_finalizer JOIN dasher.dashboard_cleanup_coordination AS target_cleanup ON target_cleanup.organization_id = target_finalizer.organization_id AND target_cleanup.dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid AND target_cleanup.completion_proof_sha256 = target_finalizer.expected_claim_set_sha256 WHERE target_finalizer.organization_id = source_snapshots.organization_id AND target_finalizer.snapshot_id = source_snapshots.snapshot_id))))
;
CREATE POLICY evidence_records_retention_lock_update
ON dasher.evidence_records
AS PERMISSIVE
FOR UPDATE
TO dasher_retention_definer
USING (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (EXISTS (SELECT 1 FROM dasher.evidence_reference_claims AS target_claim WHERE target_claim.organization_id = evidence_records.organization_id AND target_claim.evidence_id = evidence_records.evidence_id AND target_claim.dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid) OR EXISTS (SELECT 1 FROM dasher.evidence_deletion_finalizers AS target_finalizer JOIN dasher.dashboard_cleanup_coordination AS target_cleanup ON target_cleanup.organization_id = target_finalizer.organization_id AND target_cleanup.dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid AND target_cleanup.completion_proof_sha256 = target_finalizer.expected_claim_set_sha256 WHERE target_finalizer.organization_id = evidence_records.organization_id AND target_finalizer.evidence_id = evidence_records.evidence_id))))
WITH CHECK (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (EXISTS (SELECT 1 FROM dasher.evidence_reference_claims AS target_claim WHERE target_claim.organization_id = evidence_records.organization_id AND target_claim.evidence_id = evidence_records.evidence_id AND target_claim.dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid) OR EXISTS (SELECT 1 FROM dasher.evidence_deletion_finalizers AS target_finalizer JOIN dasher.dashboard_cleanup_coordination AS target_cleanup ON target_cleanup.organization_id = target_finalizer.organization_id AND target_cleanup.dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid AND target_cleanup.completion_proof_sha256 = target_finalizer.expected_claim_set_sha256 WHERE target_finalizer.organization_id = evidence_records.organization_id AND target_finalizer.evidence_id = evidence_records.evidence_id))))
;
CREATE POLICY dashboard_restore_lineage_retention_lock_update
ON dasher.dashboard_restore_lineage
AS PERMISSIVE
FOR UPDATE
TO dasher_retention_definer
USING (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)))
WITH CHECK (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)))
;
CREATE POLICY dashboard_versions_retention_lock_update
ON dasher.dashboard_versions
AS PERMISSIVE
FOR UPDATE
TO dasher_retention_definer
USING (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)))
WITH CHECK (((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = ANY (ARRAY['purge'::text])) AND EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS bound_authority WHERE bound_authority.retention_service_principal_id = (current_setting('dasher.retention_principal_id'::text, true))::uuid AND bound_authority.principal_revision = (current_setting('dasher.retention_principal_revision'::text, true))::bigint AND bound_authority.binding_kind = 'postgres_session_user'::text AND bound_authority.binding_subject = SESSION_USER AND bound_authority.authority_scope = 'platform_operator'::text AND bound_authority.scope_organization_id IS NULL AND bound_authority.enabled AND bound_authority.can_initialize AND NOT EXISTS (SELECT 1 FROM dasher.retention_service_principal_allowlist AS later_authority WHERE later_authority.retention_service_principal_id = bound_authority.retention_service_principal_id AND later_authority.principal_revision > bound_authority.principal_revision) AND CASE current_setting('dasher.retention_capability'::text, true) WHEN 'materialize_expiry'::text THEN bound_authority.can_materialize_expiry WHEN 'place_hold'::text THEN bound_authority.can_place_hold WHEN 'release_hold'::text THEN bound_authority.can_release_hold WHEN 'claim_cleanup'::text THEN bound_authority.can_claim_cleanup WHEN 'record_attempt'::text THEN bound_authority.can_record_attempt WHEN 'purge'::text THEN bound_authority.can_purge ELSE false END) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)))
;

GRANT USAGE ON SCHEMA dasher TO dasher_retention_definer;
GRANT USAGE ON SCHEMA dasher_private TO dasher_retention_definer;
GRANT USAGE ON SCHEMA dasher_retention_api TO dasher_retention_definer;
GRANT USAGE ON SCHEMA dasher_retention_api TO dasher_retention_operator;
GRANT INSERT ON TABLE dasher.audit_events TO dasher_retention_definer;
GRANT SELECT ON TABLE dasher.dashboard_lifecycle_policies TO dasher_security_definer;
GRANT SELECT ON TABLE dasher.dashboards TO dasher_security_definer;
GRANT SELECT ON TABLE dasher.dashboard_lifecycle_events TO dasher_security_definer;
GRANT SELECT ON TABLE dasher.dashboard_promotion_requests TO dasher_security_definer;
GRANT SELECT ON TABLE dasher.dashboard_promotion_decisions TO dasher_security_definer;
GRANT SELECT ON TABLE dasher.dashboard_tombstones TO dasher_security_definer;
GRANT SELECT ON TABLE dasher.dashboard_restore_lineage TO dasher_security_definer;
GRANT SELECT ON TABLE dasher.backup_deletion_ledger TO dasher_security_definer;
GRANT SELECT ON TABLE dasher.source_snapshots TO dasher_security_definer;
GRANT SELECT ON TABLE dasher.evidence_records TO dasher_security_definer;
GRANT SELECT ON TABLE dasher.dashboard_versions TO dasher_security_definer;
GRANT SELECT ON TABLE dasher.dashboard_version_snapshots TO dasher_security_definer;
GRANT SELECT ON TABLE dasher.dashboard_version_evidence TO dasher_security_definer;
GRANT SELECT ON TABLE dasher.dashboard_artifacts TO dasher_security_definer;
GRANT SELECT ON TABLE dasher.snapshot_reference_claims TO dasher_security_definer;
GRANT SELECT ON TABLE dasher.evidence_reference_claims TO dasher_security_definer;
GRANT SELECT ON TABLE dasher.artifact_reference_claims TO dasher_security_definer;
GRANT INSERT ON TABLE dasher.dashboard_lifecycle_policies TO dasher_security_definer;
GRANT INSERT ON TABLE dasher.dashboards TO dasher_security_definer;
GRANT INSERT ON TABLE dasher.dashboard_lifecycle_events TO dasher_security_definer;
GRANT INSERT ON TABLE dasher.dashboard_promotion_requests TO dasher_security_definer;
GRANT INSERT ON TABLE dasher.dashboard_promotion_decisions TO dasher_security_definer;
GRANT INSERT ON TABLE dasher.dashboard_tombstones TO dasher_security_definer;
GRANT INSERT ON TABLE dasher.dashboard_restore_lineage TO dasher_security_definer;
GRANT INSERT ON TABLE dasher.backup_deletion_ledger TO dasher_security_definer;
GRANT INSERT ON TABLE dasher.evidence_records TO dasher_security_definer;
GRANT INSERT ON TABLE dasher.dashboard_versions TO dasher_security_definer;
GRANT INSERT ON TABLE dasher.dashboard_version_snapshots TO dasher_security_definer;
GRANT INSERT ON TABLE dasher.dashboard_version_evidence TO dasher_security_definer;
GRANT INSERT ON TABLE dasher.dashboard_artifacts TO dasher_security_definer;
GRANT INSERT ON TABLE dasher.snapshot_reference_claims TO dasher_security_definer;
GRANT INSERT ON TABLE dasher.evidence_reference_claims TO dasher_security_definer;
GRANT INSERT ON TABLE dasher.artifact_reference_claims TO dasher_security_definer;
GRANT SELECT ON TABLE dasher.dashboard_lifecycle_policies TO dasher_retention_definer;
GRANT SELECT ON TABLE dasher.dashboards TO dasher_retention_definer;
GRANT SELECT ON TABLE dasher.dashboard_lifecycle_events TO dasher_retention_definer;
GRANT SELECT ON TABLE dasher.dashboard_cleanup_coordination TO dasher_retention_definer;
GRANT SELECT ON TABLE dasher.dashboard_cleanup_attempts TO dasher_retention_definer;
GRANT SELECT ON TABLE dasher.dashboard_legal_holds TO dasher_retention_definer;
GRANT SELECT ON TABLE dasher.dashboard_tombstones TO dasher_retention_definer;
GRANT SELECT ON TABLE dasher.dashboard_restore_lineage TO dasher_retention_definer;
GRANT SELECT ON TABLE dasher.backup_deletion_ledger TO dasher_retention_definer;
GRANT SELECT ON TABLE dasher.retention_service_principal_allowlist TO dasher_retention_definer;
GRANT SELECT ON TABLE dasher.source_snapshots TO dasher_retention_definer;
GRANT SELECT ON TABLE dasher.evidence_records TO dasher_retention_definer;
GRANT SELECT ON TABLE dasher.dashboard_versions TO dasher_retention_definer;
GRANT SELECT ON TABLE dasher.dashboard_version_snapshots TO dasher_retention_definer;
GRANT SELECT ON TABLE dasher.dashboard_version_evidence TO dasher_retention_definer;
GRANT SELECT ON TABLE dasher.dashboard_artifacts TO dasher_retention_definer;
GRANT SELECT ON TABLE dasher.snapshot_reference_claims TO dasher_retention_definer;
GRANT SELECT ON TABLE dasher.evidence_reference_claims TO dasher_retention_definer;
GRANT SELECT ON TABLE dasher.artifact_reference_claims TO dasher_retention_definer;
GRANT SELECT ON TABLE dasher.snapshot_deletion_finalizers TO dasher_retention_definer;
GRANT SELECT ON TABLE dasher.evidence_deletion_finalizers TO dasher_retention_definer;
GRANT SELECT ON TABLE dasher.artifact_deletion_finalizers TO dasher_retention_definer;
GRANT INSERT ON TABLE dasher.dashboard_lifecycle_events TO dasher_retention_definer;
GRANT INSERT ON TABLE dasher.dashboard_cleanup_coordination TO dasher_retention_definer;
GRANT INSERT ON TABLE dasher.dashboard_cleanup_attempts TO dasher_retention_definer;
GRANT INSERT ON TABLE dasher.dashboard_legal_holds TO dasher_retention_definer;
GRANT INSERT ON TABLE dasher.dashboard_tombstones TO dasher_retention_definer;
GRANT INSERT ON TABLE dasher.backup_deletion_ledger TO dasher_retention_definer;
GRANT INSERT ON TABLE dasher.snapshot_reference_claims TO dasher_retention_definer;
GRANT INSERT ON TABLE dasher.evidence_reference_claims TO dasher_retention_definer;
GRANT INSERT ON TABLE dasher.artifact_reference_claims TO dasher_retention_definer;
GRANT INSERT ON TABLE dasher.snapshot_deletion_finalizers TO dasher_retention_definer;
GRANT INSERT ON TABLE dasher.evidence_deletion_finalizers TO dasher_retention_definer;
GRANT INSERT ON TABLE dasher.artifact_deletion_finalizers TO dasher_retention_definer;
GRANT DELETE ON TABLE dasher.source_snapshots TO dasher_retention_definer;
GRANT DELETE ON TABLE dasher.evidence_records TO dasher_retention_definer;
GRANT DELETE ON TABLE dasher.dashboard_versions TO dasher_retention_definer;
GRANT DELETE ON TABLE dasher.dashboard_version_snapshots TO dasher_retention_definer;
GRANT DELETE ON TABLE dasher.dashboard_version_evidence TO dasher_retention_definer;
GRANT DELETE ON TABLE dasher.dashboard_artifacts TO dasher_retention_definer;
GRANT DELETE ON TABLE dasher.snapshot_reference_claims TO dasher_retention_definer;
GRANT DELETE ON TABLE dasher.evidence_reference_claims TO dasher_retention_definer;
GRANT DELETE ON TABLE dasher.artifact_reference_claims TO dasher_retention_definer;
GRANT DELETE ON TABLE dasher.dashboard_restore_lineage TO dasher_retention_definer;
GRANT UPDATE (head_version_id) ON TABLE dasher.dashboards TO dasher_security_definer;
GRANT UPDATE (lifecycle_state) ON TABLE dasher.dashboards TO dasher_security_definer;
GRANT UPDATE (lifecycle_revision) ON TABLE dasher.dashboards TO dasher_security_definer;
GRANT UPDATE (capability_epoch) ON TABLE dasher.dashboards TO dasher_security_definer;
GRANT UPDATE (cache_epoch) ON TABLE dasher.dashboards TO dasher_security_definer;
GRANT UPDATE (current_kind) ON TABLE dasher.dashboards TO dasher_security_definer;
GRANT UPDATE (effective_expires_at) ON TABLE dasher.dashboards TO dasher_security_definer;
GRANT UPDATE (promoted_at) ON TABLE dasher.dashboards TO dasher_security_definer;
GRANT UPDATE (archived_at) ON TABLE dasher.dashboards TO dasher_security_definer;
GRANT UPDATE (access_revoked_at) ON TABLE dasher.dashboards TO dasher_security_definer;
GRANT UPDATE (revocation_reason) ON TABLE dasher.dashboards TO dasher_security_definer;
GRANT UPDATE (purge_after) ON TABLE dasher.dashboards TO dasher_security_definer;
GRANT UPDATE (lifecycle_state) ON TABLE dasher.dashboards TO dasher_retention_definer;
GRANT UPDATE (lifecycle_revision) ON TABLE dasher.dashboards TO dasher_retention_definer;
GRANT UPDATE (capability_epoch) ON TABLE dasher.dashboards TO dasher_retention_definer;
GRANT UPDATE (cache_epoch) ON TABLE dasher.dashboards TO dasher_retention_definer;
GRANT UPDATE (access_revoked_at) ON TABLE dasher.dashboards TO dasher_retention_definer;
GRANT UPDATE (revocation_reason) ON TABLE dasher.dashboards TO dasher_retention_definer;
GRANT UPDATE (purge_after) ON TABLE dasher.dashboards TO dasher_retention_definer;
GRANT UPDATE (purge_started_at) ON TABLE dasher.dashboards TO dasher_retention_definer;
GRANT UPDATE (purged_at) ON TABLE dasher.dashboards TO dasher_retention_definer;
GRANT UPDATE (current_step) ON TABLE dasher.dashboard_cleanup_coordination TO dasher_retention_definer;
GRANT UPDATE (lease_owner) ON TABLE dasher.dashboard_cleanup_coordination TO dasher_retention_definer;
GRANT UPDATE (lease_expires_at) ON TABLE dasher.dashboard_cleanup_coordination TO dasher_retention_definer;
GRANT UPDATE (expected_lifecycle_revision) ON TABLE dasher.dashboard_cleanup_coordination TO dasher_retention_definer;
GRANT UPDATE (next_attempt_at) ON TABLE dasher.dashboard_cleanup_coordination TO dasher_retention_definer;
GRANT UPDATE (completion_proof_sha256) ON TABLE dasher.dashboard_cleanup_coordination TO dasher_retention_definer;
GRANT UPDATE (released_at) ON TABLE dasher.dashboard_legal_holds TO dasher_retention_definer;
GRANT UPDATE (released_by_principal_id) ON TABLE dasher.dashboard_legal_holds TO dasher_retention_definer;
GRANT UPDATE (released_authority_revision) ON TABLE dasher.dashboard_legal_holds TO dasher_retention_definer;
GRANT UPDATE (released_actor) ON TABLE dasher.dashboard_legal_holds TO dasher_retention_definer;
GRANT UPDATE (released_reason_sha256) ON TABLE dasher.dashboard_legal_holds TO dasher_retention_definer;
GRANT UPDATE (purged_at) ON TABLE dasher.dashboard_tombstones TO dasher_retention_definer;
GRANT UPDATE (purged_lifecycle_revision) ON TABLE dasher.dashboard_tombstones TO dasher_retention_definer;
GRANT UPDATE (purged_proof_sha256) ON TABLE dasher.dashboard_tombstones TO dasher_retention_definer;
GRANT UPDATE (state) ON TABLE dasher.snapshot_deletion_finalizers TO dasher_retention_definer;
GRANT UPDATE (lease_owner) ON TABLE dasher.snapshot_deletion_finalizers TO dasher_retention_definer;
GRANT UPDATE (lease_expires_at) ON TABLE dasher.snapshot_deletion_finalizers TO dasher_retention_definer;
GRANT UPDATE (proof_sha256) ON TABLE dasher.snapshot_deletion_finalizers TO dasher_retention_definer;
GRANT UPDATE (bytes_deleted_at) ON TABLE dasher.snapshot_deletion_finalizers TO dasher_retention_definer;
GRANT UPDATE (state) ON TABLE dasher.evidence_deletion_finalizers TO dasher_retention_definer;
GRANT UPDATE (lease_owner) ON TABLE dasher.evidence_deletion_finalizers TO dasher_retention_definer;
GRANT UPDATE (lease_expires_at) ON TABLE dasher.evidence_deletion_finalizers TO dasher_retention_definer;
GRANT UPDATE (proof_sha256) ON TABLE dasher.evidence_deletion_finalizers TO dasher_retention_definer;
GRANT UPDATE (bytes_deleted_at) ON TABLE dasher.evidence_deletion_finalizers TO dasher_retention_definer;
GRANT UPDATE (state) ON TABLE dasher.artifact_deletion_finalizers TO dasher_retention_definer;
GRANT UPDATE (lease_owner) ON TABLE dasher.artifact_deletion_finalizers TO dasher_retention_definer;
GRANT UPDATE (lease_expires_at) ON TABLE dasher.artifact_deletion_finalizers TO dasher_retention_definer;
GRANT UPDATE (proof_sha256) ON TABLE dasher.artifact_deletion_finalizers TO dasher_retention_definer;
GRANT UPDATE (bytes_deleted_at) ON TABLE dasher.artifact_deletion_finalizers TO dasher_retention_definer;
GRANT SELECT (organization_id) ON TABLE dasher.snapshot_deletion_finalizers TO dasher_security_definer;
GRANT SELECT (snapshot_id) ON TABLE dasher.snapshot_deletion_finalizers TO dasher_security_definer;
GRANT SELECT (organization_id) ON TABLE dasher.evidence_deletion_finalizers TO dasher_security_definer;
GRANT SELECT (evidence_id) ON TABLE dasher.evidence_deletion_finalizers TO dasher_security_definer;
GRANT SELECT (organization_id) ON TABLE dasher.artifact_deletion_finalizers TO dasher_security_definer;
GRANT SELECT (artifact_id) ON TABLE dasher.artifact_deletion_finalizers TO dasher_security_definer;
GRANT UPDATE (organization_id) ON TABLE dasher.source_snapshots TO dasher_retention_definer;
GRANT UPDATE (organization_id) ON TABLE dasher.evidence_records TO dasher_retention_definer;
GRANT UPDATE (organization_id) ON TABLE dasher.dashboard_lifecycle_policies TO dasher_security_definer;
GRANT UPDATE (organization_id) ON TABLE dasher.source_snapshots TO dasher_security_definer;
GRANT UPDATE (organization_id) ON TABLE dasher.dashboard_versions TO dasher_security_definer;
GRANT UPDATE (organization_id) ON TABLE dasher.evidence_records TO dasher_security_definer;
GRANT UPDATE (organization_id) ON TABLE dasher.dashboard_promotion_requests TO dasher_security_definer;
GRANT UPDATE (organization_id) ON TABLE dasher.dashboard_tombstones TO dasher_security_definer;
GRANT UPDATE (organization_id) ON TABLE dasher.dashboard_lifecycle_policies TO dasher_retention_definer;
GRANT UPDATE (organization_id) ON TABLE dasher.dashboard_version_snapshots TO dasher_retention_definer;
GRANT UPDATE (organization_id) ON TABLE dasher.dashboard_version_evidence TO dasher_retention_definer;
GRANT UPDATE (organization_id) ON TABLE dasher.dashboard_artifacts TO dasher_retention_definer;
GRANT UPDATE (organization_id) ON TABLE dasher.snapshot_reference_claims TO dasher_retention_definer;
GRANT UPDATE (organization_id) ON TABLE dasher.evidence_reference_claims TO dasher_retention_definer;
GRANT UPDATE (organization_id) ON TABLE dasher.artifact_reference_claims TO dasher_retention_definer;
GRANT UPDATE (organization_id) ON TABLE dasher.dashboard_restore_lineage TO dasher_retention_definer;
GRANT UPDATE (organization_id) ON TABLE dasher.dashboard_versions TO dasher_retention_definer;
