/*
 * NONCANONICAL Task 8A fixture inventory. This is an implementation contract
 * for catalog tests, not migration source, and must never be copied into the
 * canonical migrations directory.
 */

const owner = "migration_owner";

export const modeled0003FixtureIds = {
  organizationId: "10000000-0000-4000-8000-000000000001",
  dashboardId: "20000000-0000-4000-8000-000000000001",
  versionId: "30000000-0000-4000-8000-000000000001",
  snapshotId: "40000000-0000-4000-8000-000000000001",
  evidenceId: "50000000-0000-4000-8000-000000000001",
  artifactId: "60000000-0000-4000-8000-000000000001",
  principalId: "70000000-0000-4000-8000-000000000001",
  holdId: "80000000-0000-4000-8000-000000000001",
  requestId: "90000000-0000-4000-8000-000000000001",
} as const;

export const modeled0003ManagedRoles = [
  {
    name: "dasher_retention_definer",
    comment: "dasher:managed-role:v1:retention-definer",
    flags: [
      "NOLOGIN",
      "NOINHERIT",
      "NOSUPERUSER",
      "NOCREATEDB",
      "NOCREATEROLE",
      "NOREPLICATION",
      "NOBYPASSRLS",
      "PASSWORD NULL",
      "VALID UNTIL infinity",
      "CONNECTION LIMIT -1",
    ],
    settings: [],
    incomingMemberships: [],
    outgoingMemberships: [],
  },
  {
    name: "dasher_retention_operator",
    comment: "dasher:managed-role:v1:retention-operator",
    flags: [
      "NOLOGIN",
      "NOINHERIT",
      "NOSUPERUSER",
      "NOCREATEDB",
      "NOCREATEROLE",
      "NOREPLICATION",
      "NOBYPASSRLS",
      "PASSWORD NULL",
      "VALID UNTIL infinity",
      "CONNECTION LIMIT -1",
    ],
    settings: [],
    incomingMemberships: [],
    outgoingMemberships: [],
  },
] as const;

type RelationInventory = {
  readonly columns: readonly string[];
  readonly primaryKey: readonly string[];
};

function relation(
  columns: readonly string[],
  primaryKey: readonly string[],
): RelationInventory {
  return { columns, primaryKey };
}

export const modeled0003Relations = {
  dashboard_lifecycle_policies: relation(
    [
      "organization_id",
      "policy_revision",
      "default_disposable_ttl_seconds",
      "retention_policy_revision",
      "created_at",
      "created_by_user_id",
      "provenance",
    ],
    ["organization_id", "policy_revision"],
  ),
  dashboards: relation(
    [
      "organization_id",
      "dashboard_id",
      "title",
      "created_by_user_id",
      "created_at",
      "created_kind",
      "current_kind",
      "original_expires_at",
      "effective_expires_at",
      "lifecycle_state",
      "lifecycle_revision",
      "capability_epoch",
      "cache_epoch",
      "access_revoked_at",
      "revocation_reason",
      "purge_after",
      "purge_started_at",
      "purged_at",
      "retention_policy_revision",
      "promoted_at",
      "archived_at",
      "head_version_id",
      "tombstone_lineage_id",
      "restored_from_tombstone_lineage_id",
    ],
    ["organization_id", "dashboard_id"],
  ),
  dashboard_lifecycle_events: relation(
    [
      "lifecycle_event_id",
      "organization_id",
      "dashboard_id",
      "lifecycle_revision",
      "event_kind",
      "from_kind",
      "to_kind",
      "from_state",
      "to_state",
      "occurred_at",
      "actor_user_id",
      "actor_service",
      "authority_revision",
      "retention_policy_revision",
      "request_id",
      "job_id",
      "reason_sha256",
    ],
    ["organization_id", "dashboard_id", "lifecycle_revision"],
  ),
  dashboard_promotion_requests: relation(
    [
      "organization_id",
      "promotion_request_id",
      "dashboard_id",
      "requested_lifecycle_revision",
      "requested_at",
      "requested_by_user_id",
      "rationale_sha256",
    ],
    ["organization_id", "promotion_request_id"],
  ),
  dashboard_promotion_decisions: relation(
    [
      "organization_id",
      "promotion_request_id",
      "decision",
      "dashboard_lifecycle_revision",
      "decided_at",
      "decided_by_user_id",
      "retention_policy_revision",
    ],
    ["organization_id", "promotion_request_id"],
  ),
  dashboard_cleanup_coordination: relation(
    [
      "organization_id",
      "dashboard_id",
      "current_step",
      "lease_owner",
      "lease_expires_at",
      "expected_lifecycle_revision",
      "next_attempt_at",
      "completion_proof_sha256",
    ],
    ["organization_id", "dashboard_id"],
  ),
  dashboard_cleanup_attempts: relation(
    [
      "organization_id",
      "dashboard_id",
      "cleanup_attempt_id",
      "step",
      "started_at",
      "finished_at",
      "result",
      "released_claim_count",
      "deleted_resource_count",
      "deferred_claim_count",
      "failure_code",
      "proof_sha256",
    ],
    ["organization_id", "dashboard_id", "cleanup_attempt_id"],
  ),
  dashboard_legal_holds: relation(
    [
      "organization_id",
      "dashboard_id",
      "hold_id",
      "case_matter_reference",
      "placed_by_principal_id",
      "placed_authority_revision",
      "placed_actor",
      "placed_reason_sha256",
      "placed_at",
      "retention_policy_revision",
      "released_at",
      "released_by_principal_id",
      "released_authority_revision",
      "released_actor",
      "released_reason_sha256",
    ],
    ["organization_id", "dashboard_id", "hold_id"],
  ),
  dashboard_tombstones: relation(
    [
      "organization_id",
      "tombstone_lineage_id",
      "retention_policy_revision",
      "access_revoked_at",
      "access_revoked_lifecycle_revision",
      "access_revoked_proof_sha256",
      "purged_at",
      "purged_lifecycle_revision",
      "purged_proof_sha256",
    ],
    ["organization_id", "tombstone_lineage_id"],
  ),
  dashboard_restore_lineage: relation(
    [
      "organization_id",
      "dashboard_id",
      "version_id",
      "source_tombstone_lineage_id",
      "source_version_id",
      "retention_policy_revision",
      "actor_user_id",
      "authority_revision",
      "occurred_at",
      "provenance_sha256",
    ],
    ["organization_id", "dashboard_id", "version_id"],
  ),
  backup_deletion_ledger: relation(
    [
      "organization_id",
      "ledger_sequence",
      "tombstone_lineage_id",
      "lifecycle_revision",
      "event_kind",
      "event_occurred_at",
      "inserted_at",
      "retention_policy_revision",
      "proof_sha256",
    ],
    ["organization_id", "ledger_sequence"],
  ),
  retention_service_principal_allowlist: relation(
    [
      "retention_service_principal_id",
      "principal_revision",
      "binding_kind",
      "binding_subject",
      "authority_scope",
      "scope_organization_id",
      "can_initialize",
      "can_materialize_expiry",
      "can_place_hold",
      "can_release_hold",
      "can_claim_cleanup",
      "can_record_attempt",
      "can_purge",
      "enabled",
      "created_at",
      "predecessor_revision",
      "predecessor_sha256",
      "revision_sha256",
      "migration_provenance",
    ],
    ["retention_service_principal_id", "principal_revision"],
  ),
  source_snapshots: relation(
    [
      "organization_id",
      "snapshot_id",
      "source_kind",
      "canonical_bytes",
      "content_sha256",
      "observed_at",
      "retrieved_at",
      "created_at",
    ],
    ["organization_id", "snapshot_id"],
  ),
  evidence_records: relation(
    [
      "organization_id",
      "evidence_id",
      "snapshot_id",
      "evidence_kind",
      "coordinates",
      "transformation",
      "content_sha256",
      "observed_at",
      "retrieved_at",
      "created_at",
    ],
    ["organization_id", "evidence_id"],
  ),
  dashboard_versions: relation(
    [
      "organization_id",
      "dashboard_id",
      "version_id",
      "parent_version_id",
      "canonical_spec_bytes",
      "canonical_spec_sha256",
      "validation_state",
      "validation_sha256",
      "planner_provenance_sha256",
      "policy_revision",
      "registry_revision",
      "calculation_graph_sha256",
      "created_by_user_id",
      "created_at",
    ],
    ["organization_id", "dashboard_id", "version_id"],
  ),
  dashboard_version_snapshots: relation(
    ["organization_id", "dashboard_id", "version_id", "snapshot_id"],
    ["organization_id", "dashboard_id", "version_id", "snapshot_id"],
  ),
  dashboard_version_evidence: relation(
    ["organization_id", "dashboard_id", "version_id", "evidence_id"],
    ["organization_id", "dashboard_id", "version_id", "evidence_id"],
  ),
  dashboard_artifacts: relation(
    [
      "organization_id",
      "artifact_id",
      "dashboard_id",
      "version_id",
      "ownership_class",
      "artifact_kind",
      "metadata_sha256",
      "content_sha256",
      "created_at",
    ],
    ["organization_id", "artifact_id"],
  ),
  snapshot_reference_claims: relation(
    [
      "organization_id",
      "snapshot_id",
      "reference_claim_id",
      "dashboard_id",
      "version_id",
      "claim_kind",
      "hold_id",
      "created_at",
    ],
    ["organization_id", "snapshot_id", "reference_claim_id"],
  ),
  evidence_reference_claims: relation(
    [
      "organization_id",
      "evidence_id",
      "reference_claim_id",
      "dashboard_id",
      "version_id",
      "claim_kind",
      "hold_id",
      "created_at",
    ],
    ["organization_id", "evidence_id", "reference_claim_id"],
  ),
  artifact_reference_claims: relation(
    [
      "organization_id",
      "artifact_id",
      "reference_claim_id",
      "dashboard_id",
      "version_id",
      "claim_kind",
      "hold_id",
      "created_at",
    ],
    ["organization_id", "artifact_id", "reference_claim_id"],
  ),
  snapshot_deletion_finalizers: relation(
    [
      "organization_id",
      "snapshot_id",
      "state",
      "intent_at",
      "expected_claim_set_sha256",
      "lease_owner",
      "lease_expires_at",
      "proof_sha256",
      "bytes_deleted_at",
    ],
    ["organization_id", "snapshot_id"],
  ),
  evidence_deletion_finalizers: relation(
    [
      "organization_id",
      "evidence_id",
      "state",
      "intent_at",
      "expected_claim_set_sha256",
      "lease_owner",
      "lease_expires_at",
      "proof_sha256",
      "bytes_deleted_at",
    ],
    ["organization_id", "evidence_id"],
  ),
  artifact_deletion_finalizers: relation(
    [
      "organization_id",
      "artifact_id",
      "state",
      "intent_at",
      "expected_claim_set_sha256",
      "lease_owner",
      "lease_expires_at",
      "proof_sha256",
      "bytes_deleted_at",
    ],
    ["organization_id", "artifact_id"],
  ),
} as const satisfies Readonly<Record<string, RelationInventory>>;

type ModeledColumnIdentity = `${keyof typeof modeled0003Relations}.${string}`;

const modeled0003ColumnIdentitiesByType = {
  boolean: [
    "retention_service_principal_allowlist.can_initialize",
    "retention_service_principal_allowlist.can_materialize_expiry",
    "retention_service_principal_allowlist.can_place_hold",
    "retention_service_principal_allowlist.can_release_hold",
    "retention_service_principal_allowlist.can_claim_cleanup",
    "retention_service_principal_allowlist.can_record_attempt",
    "retention_service_principal_allowlist.can_purge",
    "retention_service_principal_allowlist.enabled",
  ],
  integer: [
    "dashboard_lifecycle_policies.default_disposable_ttl_seconds",
    "dashboard_cleanup_attempts.released_claim_count",
    "dashboard_cleanup_attempts.deleted_resource_count",
    "dashboard_cleanup_attempts.deferred_claim_count",
  ],
  bigint: [
    "dashboard_lifecycle_policies.policy_revision",
    "dashboard_lifecycle_policies.retention_policy_revision",
    "dashboards.lifecycle_revision",
    "dashboards.capability_epoch",
    "dashboards.cache_epoch",
    "dashboards.retention_policy_revision",
    "dashboard_lifecycle_events.lifecycle_revision",
    "dashboard_lifecycle_events.authority_revision",
    "dashboard_lifecycle_events.retention_policy_revision",
    "dashboard_promotion_requests.requested_lifecycle_revision",
    "dashboard_promotion_decisions.dashboard_lifecycle_revision",
    "dashboard_promotion_decisions.retention_policy_revision",
    "dashboard_cleanup_coordination.expected_lifecycle_revision",
    "dashboard_legal_holds.placed_authority_revision",
    "dashboard_legal_holds.retention_policy_revision",
    "dashboard_legal_holds.released_authority_revision",
    "dashboard_tombstones.retention_policy_revision",
    "dashboard_tombstones.access_revoked_lifecycle_revision",
    "dashboard_tombstones.purged_lifecycle_revision",
    "dashboard_restore_lineage.retention_policy_revision",
    "dashboard_restore_lineage.authority_revision",
    "backup_deletion_ledger.ledger_sequence",
    "backup_deletion_ledger.lifecycle_revision",
    "backup_deletion_ledger.retention_policy_revision",
    "retention_service_principal_allowlist.principal_revision",
    "retention_service_principal_allowlist.predecessor_revision",
    "dashboard_versions.policy_revision",
    "dashboard_versions.registry_revision",
  ],
  bytea: [
    "dashboard_lifecycle_events.reason_sha256",
    "dashboard_promotion_requests.rationale_sha256",
    "dashboard_cleanup_coordination.completion_proof_sha256",
    "dashboard_cleanup_attempts.proof_sha256",
    "dashboard_legal_holds.placed_reason_sha256",
    "dashboard_legal_holds.released_reason_sha256",
    "dashboard_tombstones.access_revoked_proof_sha256",
    "dashboard_tombstones.purged_proof_sha256",
    "dashboard_restore_lineage.provenance_sha256",
    "backup_deletion_ledger.proof_sha256",
    "retention_service_principal_allowlist.predecessor_sha256",
    "retention_service_principal_allowlist.revision_sha256",
    "source_snapshots.canonical_bytes",
    "source_snapshots.content_sha256",
    "evidence_records.content_sha256",
    "dashboard_versions.canonical_spec_bytes",
    "dashboard_versions.canonical_spec_sha256",
    "dashboard_versions.validation_sha256",
    "dashboard_versions.planner_provenance_sha256",
    "dashboard_versions.calculation_graph_sha256",
    "dashboard_artifacts.metadata_sha256",
    "dashboard_artifacts.content_sha256",
    "snapshot_deletion_finalizers.expected_claim_set_sha256",
    "snapshot_deletion_finalizers.proof_sha256",
    "evidence_deletion_finalizers.expected_claim_set_sha256",
    "evidence_deletion_finalizers.proof_sha256",
    "artifact_deletion_finalizers.expected_claim_set_sha256",
    "artifact_deletion_finalizers.proof_sha256",
  ],
  name: [
    "dashboard_cleanup_coordination.lease_owner",
    "retention_service_principal_allowlist.binding_subject",
    "snapshot_deletion_finalizers.lease_owner",
    "evidence_deletion_finalizers.lease_owner",
    "artifact_deletion_finalizers.lease_owner",
  ],
  text: [
    "dashboard_lifecycle_policies.provenance",
    "dashboards.title",
    "dashboards.created_kind",
    "dashboards.current_kind",
    "dashboards.lifecycle_state",
    "dashboards.revocation_reason",
    "dashboard_lifecycle_events.event_kind",
    "dashboard_lifecycle_events.from_kind",
    "dashboard_lifecycle_events.to_kind",
    "dashboard_lifecycle_events.from_state",
    "dashboard_lifecycle_events.to_state",
    "dashboard_lifecycle_events.actor_service",
    "dashboard_promotion_decisions.decision",
    "dashboard_cleanup_coordination.current_step",
    "dashboard_cleanup_attempts.step",
    "dashboard_cleanup_attempts.result",
    "dashboard_cleanup_attempts.failure_code",
    "dashboard_legal_holds.case_matter_reference",
    "dashboard_legal_holds.placed_actor",
    "dashboard_legal_holds.released_actor",
    "backup_deletion_ledger.event_kind",
    "retention_service_principal_allowlist.binding_kind",
    "retention_service_principal_allowlist.authority_scope",
    "retention_service_principal_allowlist.migration_provenance",
    "source_snapshots.source_kind",
    "evidence_records.evidence_kind",
    "evidence_records.coordinates",
    "evidence_records.transformation",
    "dashboard_versions.validation_state",
    "dashboard_artifacts.ownership_class",
    "dashboard_artifacts.artifact_kind",
    "snapshot_reference_claims.claim_kind",
    "evidence_reference_claims.claim_kind",
    "artifact_reference_claims.claim_kind",
    "snapshot_deletion_finalizers.state",
    "evidence_deletion_finalizers.state",
    "artifact_deletion_finalizers.state",
  ],
  "timestamp with time zone": [
    "dashboard_lifecycle_policies.created_at",
    "dashboards.created_at",
    "dashboards.original_expires_at",
    "dashboards.effective_expires_at",
    "dashboards.access_revoked_at",
    "dashboards.purge_after",
    "dashboards.purge_started_at",
    "dashboards.purged_at",
    "dashboards.promoted_at",
    "dashboards.archived_at",
    "dashboard_lifecycle_events.occurred_at",
    "dashboard_promotion_requests.requested_at",
    "dashboard_promotion_decisions.decided_at",
    "dashboard_cleanup_coordination.lease_expires_at",
    "dashboard_cleanup_coordination.next_attempt_at",
    "dashboard_cleanup_attempts.started_at",
    "dashboard_cleanup_attempts.finished_at",
    "dashboard_legal_holds.placed_at",
    "dashboard_legal_holds.released_at",
    "dashboard_tombstones.access_revoked_at",
    "dashboard_tombstones.purged_at",
    "dashboard_restore_lineage.occurred_at",
    "backup_deletion_ledger.event_occurred_at",
    "backup_deletion_ledger.inserted_at",
    "retention_service_principal_allowlist.created_at",
    "source_snapshots.observed_at",
    "source_snapshots.retrieved_at",
    "source_snapshots.created_at",
    "evidence_records.observed_at",
    "evidence_records.retrieved_at",
    "evidence_records.created_at",
    "dashboard_versions.created_at",
    "dashboard_artifacts.created_at",
    "snapshot_reference_claims.created_at",
    "evidence_reference_claims.created_at",
    "artifact_reference_claims.created_at",
    "snapshot_deletion_finalizers.intent_at",
    "snapshot_deletion_finalizers.lease_expires_at",
    "snapshot_deletion_finalizers.bytes_deleted_at",
    "evidence_deletion_finalizers.intent_at",
    "evidence_deletion_finalizers.lease_expires_at",
    "evidence_deletion_finalizers.bytes_deleted_at",
    "artifact_deletion_finalizers.intent_at",
    "artifact_deletion_finalizers.lease_expires_at",
    "artifact_deletion_finalizers.bytes_deleted_at",
  ],
  uuid: [
    "dashboard_lifecycle_policies.organization_id",
    "dashboard_lifecycle_policies.created_by_user_id",
    "dashboards.organization_id",
    "dashboards.dashboard_id",
    "dashboards.created_by_user_id",
    "dashboards.head_version_id",
    "dashboards.tombstone_lineage_id",
    "dashboards.restored_from_tombstone_lineage_id",
    "dashboard_lifecycle_events.lifecycle_event_id",
    "dashboard_lifecycle_events.organization_id",
    "dashboard_lifecycle_events.dashboard_id",
    "dashboard_lifecycle_events.actor_user_id",
    "dashboard_lifecycle_events.request_id",
    "dashboard_lifecycle_events.job_id",
    "dashboard_promotion_requests.organization_id",
    "dashboard_promotion_requests.promotion_request_id",
    "dashboard_promotion_requests.dashboard_id",
    "dashboard_promotion_requests.requested_by_user_id",
    "dashboard_promotion_decisions.organization_id",
    "dashboard_promotion_decisions.promotion_request_id",
    "dashboard_promotion_decisions.decided_by_user_id",
    "dashboard_cleanup_coordination.organization_id",
    "dashboard_cleanup_coordination.dashboard_id",
    "dashboard_cleanup_attempts.organization_id",
    "dashboard_cleanup_attempts.dashboard_id",
    "dashboard_cleanup_attempts.cleanup_attempt_id",
    "dashboard_legal_holds.organization_id",
    "dashboard_legal_holds.dashboard_id",
    "dashboard_legal_holds.hold_id",
    "dashboard_legal_holds.placed_by_principal_id",
    "dashboard_legal_holds.released_by_principal_id",
    "dashboard_tombstones.organization_id",
    "dashboard_tombstones.tombstone_lineage_id",
    "dashboard_restore_lineage.organization_id",
    "dashboard_restore_lineage.dashboard_id",
    "dashboard_restore_lineage.version_id",
    "dashboard_restore_lineage.source_tombstone_lineage_id",
    "dashboard_restore_lineage.source_version_id",
    "dashboard_restore_lineage.actor_user_id",
    "backup_deletion_ledger.organization_id",
    "backup_deletion_ledger.tombstone_lineage_id",
    "retention_service_principal_allowlist.retention_service_principal_id",
    "retention_service_principal_allowlist.scope_organization_id",
    "source_snapshots.organization_id",
    "source_snapshots.snapshot_id",
    "evidence_records.organization_id",
    "evidence_records.evidence_id",
    "evidence_records.snapshot_id",
    "dashboard_versions.organization_id",
    "dashboard_versions.dashboard_id",
    "dashboard_versions.version_id",
    "dashboard_versions.parent_version_id",
    "dashboard_versions.created_by_user_id",
    "dashboard_version_snapshots.organization_id",
    "dashboard_version_snapshots.dashboard_id",
    "dashboard_version_snapshots.version_id",
    "dashboard_version_snapshots.snapshot_id",
    "dashboard_version_evidence.organization_id",
    "dashboard_version_evidence.dashboard_id",
    "dashboard_version_evidence.version_id",
    "dashboard_version_evidence.evidence_id",
    "dashboard_artifacts.organization_id",
    "dashboard_artifacts.artifact_id",
    "dashboard_artifacts.dashboard_id",
    "dashboard_artifacts.version_id",
    "snapshot_reference_claims.organization_id",
    "snapshot_reference_claims.snapshot_id",
    "snapshot_reference_claims.reference_claim_id",
    "snapshot_reference_claims.dashboard_id",
    "snapshot_reference_claims.version_id",
    "snapshot_reference_claims.hold_id",
    "evidence_reference_claims.organization_id",
    "evidence_reference_claims.evidence_id",
    "evidence_reference_claims.reference_claim_id",
    "evidence_reference_claims.dashboard_id",
    "evidence_reference_claims.version_id",
    "evidence_reference_claims.hold_id",
    "artifact_reference_claims.organization_id",
    "artifact_reference_claims.artifact_id",
    "artifact_reference_claims.reference_claim_id",
    "artifact_reference_claims.dashboard_id",
    "artifact_reference_claims.version_id",
    "artifact_reference_claims.hold_id",
    "snapshot_deletion_finalizers.organization_id",
    "snapshot_deletion_finalizers.snapshot_id",
    "evidence_deletion_finalizers.organization_id",
    "evidence_deletion_finalizers.evidence_id",
    "artifact_deletion_finalizers.organization_id",
    "artifact_deletion_finalizers.artifact_id",
  ],
} as const satisfies Readonly<Record<string, readonly ModeledColumnIdentity[]>>;

const modeled0003NullableColumnIdentities = new Set<ModeledColumnIdentity>([
  "dashboards.original_expires_at",
  "dashboards.effective_expires_at",
  "dashboards.access_revoked_at",
  "dashboards.revocation_reason",
  "dashboards.purge_after",
  "dashboards.purge_started_at",
  "dashboards.purged_at",
  "dashboards.promoted_at",
  "dashboards.archived_at",
  "dashboards.head_version_id",
  "dashboards.restored_from_tombstone_lineage_id",
  "dashboard_lifecycle_events.from_kind",
  "dashboard_lifecycle_events.to_kind",
  "dashboard_lifecycle_events.from_state",
  "dashboard_lifecycle_events.to_state",
  "dashboard_lifecycle_events.actor_user_id",
  "dashboard_lifecycle_events.actor_service",
  "dashboard_lifecycle_events.job_id",
  "dashboard_cleanup_coordination.lease_owner",
  "dashboard_cleanup_coordination.lease_expires_at",
  "dashboard_cleanup_coordination.next_attempt_at",
  "dashboard_cleanup_coordination.completion_proof_sha256",
  "dashboard_cleanup_attempts.finished_at",
  "dashboard_cleanup_attempts.failure_code",
  "dashboard_cleanup_attempts.proof_sha256",
  "dashboard_legal_holds.released_at",
  "dashboard_legal_holds.released_by_principal_id",
  "dashboard_legal_holds.released_authority_revision",
  "dashboard_legal_holds.released_actor",
  "dashboard_legal_holds.released_reason_sha256",
  "dashboard_tombstones.purged_at",
  "dashboard_tombstones.purged_lifecycle_revision",
  "dashboard_tombstones.purged_proof_sha256",
  "dashboard_restore_lineage.actor_user_id",
  "backup_deletion_ledger.proof_sha256",
  "retention_service_principal_allowlist.scope_organization_id",
  "retention_service_principal_allowlist.predecessor_revision",
  "retention_service_principal_allowlist.predecessor_sha256",
  "dashboard_versions.parent_version_id",
  "dashboard_versions.calculation_graph_sha256",
  "dashboard_artifacts.dashboard_id",
  "dashboard_artifacts.version_id",
  "snapshot_reference_claims.hold_id",
  "evidence_reference_claims.hold_id",
  "artifact_reference_claims.hold_id",
  "snapshot_deletion_finalizers.lease_owner",
  "snapshot_deletion_finalizers.lease_expires_at",
  "snapshot_deletion_finalizers.proof_sha256",
  "snapshot_deletion_finalizers.bytes_deleted_at",
  "evidence_deletion_finalizers.lease_owner",
  "evidence_deletion_finalizers.lease_expires_at",
  "evidence_deletion_finalizers.proof_sha256",
  "evidence_deletion_finalizers.bytes_deleted_at",
  "artifact_deletion_finalizers.lease_owner",
  "artifact_deletion_finalizers.lease_expires_at",
  "artifact_deletion_finalizers.proof_sha256",
  "artifact_deletion_finalizers.bytes_deleted_at",
]);

const modeled0003ColumnTypeByIdentity = new Map<
  ModeledColumnIdentity,
  string
>();
for (const [type, identities] of Object.entries(
  modeled0003ColumnIdentitiesByType,
)) {
  for (const identity of identities) {
    if (modeled0003ColumnTypeByIdentity.has(identity)) {
      throw new Error(`duplicate modeled column type identity: ${identity}`);
    }
    modeled0003ColumnTypeByIdentity.set(identity, type);
  }
}

export const modeled0003ColumnCatalog = Object.entries(
  modeled0003Relations,
).flatMap(([relationName, inventory]) =>
  inventory.columns.map((columnName, ordinal) => {
    const identity = `${relationName}.${columnName}` as ModeledColumnIdentity;
    const type = modeled0003ColumnTypeByIdentity.get(identity);
    if (type === undefined) {
      throw new Error(`missing modeled column type identity: ${identity}`);
    }
    return {
      relationName,
      columnName,
      ordinal: ordinal + 1,
      type,
      nullable: modeled0003NullableColumnIdentities.has(identity),
      defaultExpression: null,
      generated: "",
      identity: "",
    };
  }),
);

if (modeled0003ColumnTypeByIdentity.size !== modeled0003ColumnCatalog.length) {
  throw new Error("modeled column type inventory is not an exact closure");
}

const appFunctions = [
  ["list_dashboards", "integer", "SETOF dasher.dashboard_summary"],
  ["get_dashboard_summary", "uuid", "dasher.dashboard_summary"],
  ["get_dashboard_head", "uuid", "uuid"],
  [
    "get_dashboard_version",
    "uuid, uuid",
    "dasher.dashboard_version_projection",
  ],
  [
    "get_dashboard_evidence",
    "uuid, uuid",
    "SETOF dasher.dashboard_evidence_projection",
  ],
  [
    "get_dashboard_lineage",
    "uuid, uuid",
    "SETOF dasher.dashboard_lineage_projection",
  ],
  ["get_dashboard_admin_status", "uuid", "dasher.dashboard_admin_projection"],
  [
    "create_dashboard",
    "uuid, text, text, integer, boolean, uuid, uuid, text",
    "uuid",
  ],
  [
    "create_evidence_record",
    "uuid, uuid, uuid, uuid, text, text, bytea, timestamptz, timestamptz, uuid, text",
    "void",
  ],
  [
    "create_dashboard_version",
    "uuid, uuid, uuid, bytea, bytea, uuid, bytea, bytea, bigint, bigint, bytea, uuid[], uuid[], uuid, text",
    "uuid",
  ],
  [
    "compare_and_swap_dashboard_head",
    "uuid, uuid, uuid, bigint, uuid, text",
    "void",
  ],
  [
    "request_dashboard_promotion",
    "uuid, uuid, bigint, bytea, uuid, text",
    "uuid",
  ],
  [
    "decide_dashboard_promotion",
    "uuid, uuid, uuid, bigint, text, uuid, text",
    "void",
  ],
  ["set_dashboard_archive", "uuid, boolean, bigint, uuid, text", "void"],
  ["delete_dashboard", "uuid, bigint, uuid, text", "void"],
  [
    "restore_dashboard_as_new",
    "uuid, uuid, uuid, uuid, text, uuid, text",
    "void",
  ],
] as const;

const retentionFunctions = [
  ["initialize_operator_context", "uuid, text, uuid, text", "void"],
  ["materialize_dashboard_expiry", "uuid, bigint, uuid, text", "void"],
  [
    "place_dashboard_legal_hold",
    "uuid, uuid, text, bytea, bigint, uuid, text",
    "void",
  ],
  [
    "release_dashboard_legal_hold",
    "uuid, uuid, bytea, bigint, uuid, text",
    "void",
  ],
  [
    "claim_dashboard_cleanup",
    "uuid, text, bigint, text, interval, uuid, text",
    "void",
  ],
  [
    "record_dashboard_cleanup_attempt",
    "uuid, uuid, text, text, integer, integer, integer, bytea, uuid, text",
    "void",
  ],
  ["purge_dashboard", "uuid, bigint, uuid, text", "void"],
] as const;

const triggerFunctions = [
  ["reject_dashboard_append_mutation", "trigger"],
  ["enforce_dashboard_transition", "trigger"],
  ["enforce_retention_mutation", "trigger"],
] as const;

export const modeled0003Functions = [
  ...appFunctions.map(([name, identityArguments, returns]) => ({
    schema: "dasher_api",
    name,
    identityArguments,
    returns,
    language: "plpgsql",
    volatility: "VOLATILE",
    securityDefiner: true,
    owner: "dasher_security_definer",
    proconfig: ["search_path=pg_catalog"],
    execute: ["dasher_app"],
    defaults: [],
    variadic: false,
  })),
  ...retentionFunctions.map(([name, identityArguments, returns]) => ({
    schema: "dasher_retention_api",
    name,
    identityArguments,
    returns,
    language: "plpgsql",
    volatility: "VOLATILE",
    securityDefiner: true,
    owner: "dasher_retention_definer",
    proconfig: ["search_path=pg_catalog"],
    execute: ["dasher_retention_operator"],
    defaults: [],
    variadic: false,
  })),
  ...triggerFunctions.map(([name, returns]) => ({
    schema: "dasher_private",
    name,
    identityArguments: "",
    returns,
    language: "plpgsql",
    volatility: "VOLATILE",
    securityDefiner: false,
    owner,
    proconfig: ["search_path=pg_catalog"],
    execute: [],
    defaults: [],
    variadic: false,
  })),
] as const;

export const modeled0003ReturnColumns = {
  "dasher.dashboard_summary": [
    "dashboard_id uuid",
    "title text",
    "current_kind text",
    "lifecycle_state text",
    "lifecycle_revision bigint",
    "effective_expires_at timestamptz",
    "head_version_id uuid",
  ],
  "dasher.dashboard_version_projection": [
    "dashboard_id uuid",
    "version_id uuid",
    "parent_version_id uuid",
    "canonical_spec_sha256 bytea",
    "validation_state text",
    "validation_sha256 bytea",
    "planner_provenance_sha256 bytea",
    "policy_revision bigint",
    "registry_revision bigint",
    "calculation_graph_sha256 bytea",
    "created_at timestamptz",
  ],
  "dasher.dashboard_evidence_projection": [
    "dashboard_id uuid",
    "version_id uuid",
    "evidence_id uuid",
    "evidence_kind text",
    "content_sha256 bytea",
    "observed_at timestamptz",
    "retrieved_at timestamptz",
  ],
  "dasher.dashboard_lineage_projection": [
    "dashboard_id uuid",
    "version_id uuid",
    "parent_version_id uuid",
    "snapshot_id uuid",
    "evidence_id uuid",
    "artifact_id uuid",
  ],
  "dasher.dashboard_admin_projection": [
    "dashboard_id uuid",
    "lifecycle_state text",
    "lifecycle_revision bigint",
    "capability_epoch bigint",
    "cache_epoch bigint",
    "access_revoked_at timestamptz",
    "purge_after timestamptz",
    "purge_started_at timestamptz",
    "purged_at timestamptz",
    "active_hold_count bigint",
    "cleanup_step text",
  ],
} as const;

export const modeled0003InitializerBodyContract = {
  identity:
    "dasher_retention_api.initialize_operator_context(uuid, text, uuid, text)",
  requiredOrder: [
    "exact-read-committed-check",
    "all-reserved-context-keys-empty-check",
    "derive-gate-from-postgres-session-user-binding",
    "pg_advisory_xact_lock-binding-gate",
    "distinct-ordinary-post-gate-allowlist-select",
    "select-highest-revision-regardless-enabled",
    "validate-predecessor-and-hash-chain",
    "deny-latest-disabled-or-missing-capability-without-fallback",
    "set-target-discovery-context",
    "single-dashboard-organization-projection-without-tuple-lock",
    "pg_advisory_xact_lock-derived-organization-gate",
    "replace-context-with-full-authorized-context",
    "ordinary-policy-dashboard-lock-and-revalidation",
  ],
  reservedContextKeys: [
    "dasher.retention_phase",
    "dasher.retention_principal_id",
    "dasher.retention_principal_revision",
    "dasher.retention_authority_scope",
    "dasher.retention_capability",
    "dasher.retention_target_dashboard_id",
    "dasher.retention_target_organization_id",
    "dasher.retention_request_id",
    "dasher.retention_case_matter_reference",
  ],
  forbiddenSql: [
    "SELECT FOR UPDATE on retention_service_principal_allowlist",
    "SELECT FOR SHARE on retention_service_principal_allowlist",
    "pre-gate allowlist read or cache",
    "unlocked max(principal_revision)",
    "latest-enabled fallback",
    "dynamic SQL",
    "STABLE wrapper",
    "IMMUTABLE wrapper",
  ],
  writerGateUsers: [
    "migration-owner synthetic seed",
    "migration-owner synthetic cleanup",
    "every future reviewed enrollment/revision/revocation writer",
  ],
  bindingGateIdentity:
    "postgres_session_user|session_user via dasher:retention-principal-binding:v1",
  writerOperationOrder: [
    "derive identical immutable binding gate",
    "pg_advisory_xact_lock identical binding gate",
    "append synthetic revision or remove synthetic fixture",
    "commit before gate release",
  ],
} as const;

export const modeled0003Policies = [
  {
    name: "retention_service_principal_self_binding_select",
    relation: "retention_service_principal_allowlist",
    command: "SELECT",
    catalogCommand: "r",
    permissive: true,
    roles: ["dasher_retention_definer"],
    bootstrap: true,
    columns: modeled0003Relations.retention_service_principal_allowlist.columns,
    shutsOffWhenPhase: null,
    using:
      "((CURRENT_USER = 'dasher_retention_definer'::name) AND (binding_kind = 'postgres_session_user'::text) AND (binding_subject = SESSION_USER))",
    withCheck: null,
  },
  {
    name: "dashboards_retention_target_discovery_select",
    relation: "dashboards",
    command: "SELECT",
    catalogCommand: "r",
    permissive: true,
    roles: ["dasher_retention_definer"],
    bootstrap: true,
    columns: ["organization_id"],
    shutsOffWhenPhase: "authorized",
    using:
      "((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'target_discovery'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) = 'initialize'::text) AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid))",
    withCheck: null,
  },
  ...Object.keys(modeled0003Relations)
    .filter(
      (relationName) =>
        relationName !== "retention_service_principal_allowlist",
    )
    .map((relationName) => ({
      name: `${relationName}_authorized_context`,
      relation: relationName,
      command: "ALL",
      catalogCommand: "*",
      permissive: true,
      roles: ["dasher_retention_definer"],
      bootstrap: false,
      columns:
        modeled0003Relations[relationName as ModeledRelationName].columns,
      shutsOffWhenPhase: null,
      using: `((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) <> ''::text) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid)${
        modeled0003Relations[
          relationName as ModeledRelationName
        ].columns.includes("dashboard_id")
          ? " AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)"
          : ""
      })`,
      withCheck: `((CURRENT_USER = 'dasher_retention_definer'::name) AND (current_setting('dasher.retention_phase'::text, true) = 'authorized'::text) AND (current_setting('dasher.retention_principal_id'::text, true) <> ''::text) AND (current_setting('dasher.retention_principal_revision'::text, true) <> ''::text) AND (current_setting('dasher.retention_authority_scope'::text, true) = 'platform_operator'::text) AND (current_setting('dasher.retention_capability'::text, true) <> ''::text) AND (organization_id = (current_setting('dasher.retention_target_organization_id'::text, true))::uuid)${
        modeled0003Relations[
          relationName as ModeledRelationName
        ].columns.includes("dashboard_id")
          ? " AND (dashboard_id = (current_setting('dasher.retention_target_dashboard_id'::text, true))::uuid)"
          : ""
      })`,
    })),
] as const;

function foreignKey(
  name: string,
  relationName: ModeledRelationName,
  columns: readonly string[],
  targetRelation: string,
  targetColumns: readonly string[],
  deferred = false,
) {
  return {
    name,
    relation: relationName,
    type: "FOREIGN KEY",
    columns,
    targetRelation,
    targetColumns,
    deferred,
    deferrable: deferred,
    initiallyDeferred: deferred,
    validated: true,
    matchType: "s",
    updateAction: "a",
    deleteAction: "a",
    definition: `FOREIGN KEY (${columns.join(", ")}) REFERENCES dasher.${targetRelation}(${targetColumns.join(", ")})${deferred ? " DEFERRABLE INITIALLY DEFERRED" : ""}`,
  } as const;
}

export const modeled0003ForeignKeys = [
  foreignKey(
    "dashboard_lifecycle_policies_organization_fk",
    "dashboard_lifecycle_policies",
    ["organization_id"],
    "organizations",
    ["organization_id"],
  ),
  foreignKey(
    "dashboards_organization_fk",
    "dashboards",
    ["organization_id"],
    "organizations",
    ["organization_id"],
  ),
  foreignKey(
    "dashboards_creator_fk",
    "dashboards",
    ["created_by_user_id"],
    "users",
    ["user_id"],
  ),
  foreignKey(
    "dashboards_head_version_fk",
    "dashboards",
    ["organization_id", "dashboard_id", "head_version_id"],
    "dashboard_versions",
    ["organization_id", "dashboard_id", "version_id"],
    true,
  ),
  foreignKey(
    "dashboards_restore_tombstone_fk",
    "dashboards",
    ["organization_id", "restored_from_tombstone_lineage_id"],
    "dashboard_tombstones",
    ["organization_id", "tombstone_lineage_id"],
  ),
  foreignKey(
    "dashboard_lifecycle_events_dashboard_fk",
    "dashboard_lifecycle_events",
    ["organization_id", "dashboard_id"],
    "dashboards",
    ["organization_id", "dashboard_id"],
  ),
  foreignKey(
    "dashboard_promotion_requests_dashboard_fk",
    "dashboard_promotion_requests",
    ["organization_id", "dashboard_id"],
    "dashboards",
    ["organization_id", "dashboard_id"],
  ),
  foreignKey(
    "dashboard_promotion_decisions_request_fk",
    "dashboard_promotion_decisions",
    ["organization_id", "promotion_request_id"],
    "dashboard_promotion_requests",
    ["organization_id", "promotion_request_id"],
  ),
  foreignKey(
    "dashboard_cleanup_coordination_dashboard_fk",
    "dashboard_cleanup_coordination",
    ["organization_id", "dashboard_id"],
    "dashboards",
    ["organization_id", "dashboard_id"],
  ),
  foreignKey(
    "dashboard_cleanup_attempts_dashboard_fk",
    "dashboard_cleanup_attempts",
    ["organization_id", "dashboard_id"],
    "dashboards",
    ["organization_id", "dashboard_id"],
  ),
  foreignKey(
    "dashboard_legal_holds_dashboard_fk",
    "dashboard_legal_holds",
    ["organization_id", "dashboard_id"],
    "dashboards",
    ["organization_id", "dashboard_id"],
  ),
  foreignKey(
    "dashboard_restore_lineage_dashboard_version_fk",
    "dashboard_restore_lineage",
    ["organization_id", "dashboard_id", "version_id"],
    "dashboard_versions",
    ["organization_id", "dashboard_id", "version_id"],
  ),
  foreignKey(
    "dashboard_restore_lineage_tombstone_fk",
    "dashboard_restore_lineage",
    ["organization_id", "source_tombstone_lineage_id"],
    "dashboard_tombstones",
    ["organization_id", "tombstone_lineage_id"],
  ),
  foreignKey(
    "backup_deletion_ledger_tombstone_fk",
    "backup_deletion_ledger",
    ["organization_id", "tombstone_lineage_id"],
    "dashboard_tombstones",
    ["organization_id", "tombstone_lineage_id"],
  ),
  foreignKey(
    "retention_allowlist_scope_organization_fk",
    "retention_service_principal_allowlist",
    ["scope_organization_id"],
    "organizations",
    ["organization_id"],
  ),
  foreignKey(
    "source_snapshots_organization_fk",
    "source_snapshots",
    ["organization_id"],
    "organizations",
    ["organization_id"],
  ),
  foreignKey(
    "evidence_records_snapshot_fk",
    "evidence_records",
    ["organization_id", "snapshot_id"],
    "source_snapshots",
    ["organization_id", "snapshot_id"],
  ),
  foreignKey(
    "dashboard_versions_dashboard_fk",
    "dashboard_versions",
    ["organization_id", "dashboard_id"],
    "dashboards",
    ["organization_id", "dashboard_id"],
  ),
  foreignKey(
    "dashboard_versions_parent_fk",
    "dashboard_versions",
    ["organization_id", "dashboard_id", "parent_version_id"],
    "dashboard_versions",
    ["organization_id", "dashboard_id", "version_id"],
  ),
  foreignKey(
    "dashboard_version_snapshots_version_fk",
    "dashboard_version_snapshots",
    ["organization_id", "dashboard_id", "version_id"],
    "dashboard_versions",
    ["organization_id", "dashboard_id", "version_id"],
  ),
  foreignKey(
    "dashboard_version_snapshots_snapshot_fk",
    "dashboard_version_snapshots",
    ["organization_id", "snapshot_id"],
    "source_snapshots",
    ["organization_id", "snapshot_id"],
  ),
  foreignKey(
    "dashboard_version_evidence_version_fk",
    "dashboard_version_evidence",
    ["organization_id", "dashboard_id", "version_id"],
    "dashboard_versions",
    ["organization_id", "dashboard_id", "version_id"],
  ),
  foreignKey(
    "dashboard_version_evidence_evidence_fk",
    "dashboard_version_evidence",
    ["organization_id", "evidence_id"],
    "evidence_records",
    ["organization_id", "evidence_id"],
  ),
  foreignKey(
    "dashboard_artifacts_version_fk",
    "dashboard_artifacts",
    ["organization_id", "dashboard_id", "version_id"],
    "dashboard_versions",
    ["organization_id", "dashboard_id", "version_id"],
  ),
  foreignKey(
    "snapshot_reference_claims_snapshot_fk",
    "snapshot_reference_claims",
    ["organization_id", "snapshot_id"],
    "source_snapshots",
    ["organization_id", "snapshot_id"],
  ),
  foreignKey(
    "snapshot_reference_claims_version_fk",
    "snapshot_reference_claims",
    ["organization_id", "dashboard_id", "version_id"],
    "dashboard_versions",
    ["organization_id", "dashboard_id", "version_id"],
  ),
  foreignKey(
    "snapshot_reference_claims_hold_fk",
    "snapshot_reference_claims",
    ["organization_id", "dashboard_id", "hold_id"],
    "dashboard_legal_holds",
    ["organization_id", "dashboard_id", "hold_id"],
  ),
  foreignKey(
    "evidence_reference_claims_evidence_fk",
    "evidence_reference_claims",
    ["organization_id", "evidence_id"],
    "evidence_records",
    ["organization_id", "evidence_id"],
  ),
  foreignKey(
    "evidence_reference_claims_version_fk",
    "evidence_reference_claims",
    ["organization_id", "dashboard_id", "version_id"],
    "dashboard_versions",
    ["organization_id", "dashboard_id", "version_id"],
  ),
  foreignKey(
    "evidence_reference_claims_hold_fk",
    "evidence_reference_claims",
    ["organization_id", "dashboard_id", "hold_id"],
    "dashboard_legal_holds",
    ["organization_id", "dashboard_id", "hold_id"],
  ),
  foreignKey(
    "artifact_reference_claims_artifact_fk",
    "artifact_reference_claims",
    ["organization_id", "artifact_id"],
    "dashboard_artifacts",
    ["organization_id", "artifact_id"],
  ),
  foreignKey(
    "artifact_reference_claims_version_fk",
    "artifact_reference_claims",
    ["organization_id", "dashboard_id", "version_id"],
    "dashboard_versions",
    ["organization_id", "dashboard_id", "version_id"],
  ),
  foreignKey(
    "artifact_reference_claims_hold_fk",
    "artifact_reference_claims",
    ["organization_id", "dashboard_id", "hold_id"],
    "dashboard_legal_holds",
    ["organization_id", "dashboard_id", "hold_id"],
  ),
  foreignKey(
    "snapshot_deletion_finalizers_snapshot_fk",
    "snapshot_deletion_finalizers",
    ["organization_id", "snapshot_id"],
    "source_snapshots",
    ["organization_id", "snapshot_id"],
  ),
  foreignKey(
    "evidence_deletion_finalizers_evidence_fk",
    "evidence_deletion_finalizers",
    ["organization_id", "evidence_id"],
    "evidence_records",
    ["organization_id", "evidence_id"],
  ),
  foreignKey(
    "artifact_deletion_finalizers_artifact_fk",
    "artifact_deletion_finalizers",
    ["organization_id", "artifact_id"],
    "dashboard_artifacts",
    ["organization_id", "artifact_id"],
  ),
] as const;

type ModeledRelationName = keyof typeof modeled0003Relations;

function allColumns(relationName: ModeledRelationName): readonly string[] {
  return modeled0003Relations[relationName].columns;
}

function columnAcl(
  role: "dasher_retention_definer" | "dasher_security_definer",
  relationName: ModeledRelationName,
  privilege: "DELETE" | "INSERT" | "SELECT" | "UPDATE",
  columns: readonly string[] = allColumns(relationName),
) {
  return { role, relationName, privilege, columns } as const;
}

export const modeled0003EffectiveColumnPrivileges = [
  ...(
    [
      "dashboard_lifecycle_policies",
      "dashboards",
      "dashboard_lifecycle_events",
      "dashboard_promotion_requests",
      "dashboard_promotion_decisions",
      "dashboard_tombstones",
      "dashboard_restore_lineage",
      "backup_deletion_ledger",
      "source_snapshots",
      "evidence_records",
      "dashboard_versions",
      "dashboard_version_snapshots",
      "dashboard_version_evidence",
      "dashboard_artifacts",
      "snapshot_reference_claims",
      "evidence_reference_claims",
      "artifact_reference_claims",
    ] as const
  ).map((relationName) =>
    columnAcl("dasher_security_definer", relationName, "SELECT"),
  ),
  ...(
    [
      "dashboard_lifecycle_policies",
      "dashboards",
      "dashboard_lifecycle_events",
      "dashboard_promotion_requests",
      "dashboard_promotion_decisions",
      "dashboard_tombstones",
      "dashboard_restore_lineage",
      "backup_deletion_ledger",
      "evidence_records",
      "dashboard_versions",
      "dashboard_version_snapshots",
      "dashboard_version_evidence",
      "dashboard_artifacts",
      "snapshot_reference_claims",
      "evidence_reference_claims",
      "artifact_reference_claims",
    ] as const
  ).map((relationName) =>
    columnAcl("dasher_security_definer", relationName, "INSERT"),
  ),
  columnAcl("dasher_security_definer", "dashboards", "UPDATE", [
    "head_version_id",
    "lifecycle_state",
    "lifecycle_revision",
    "capability_epoch",
    "cache_epoch",
    "current_kind",
    "effective_expires_at",
    "promoted_at",
    "archived_at",
    "access_revoked_at",
    "revocation_reason",
    "purge_after",
  ]),
  ...(
    [
      "dashboard_lifecycle_policies",
      "dashboards",
      "dashboard_lifecycle_events",
      "dashboard_cleanup_coordination",
      "dashboard_cleanup_attempts",
      "dashboard_legal_holds",
      "dashboard_tombstones",
      "dashboard_restore_lineage",
      "backup_deletion_ledger",
      "retention_service_principal_allowlist",
      "source_snapshots",
      "evidence_records",
      "dashboard_versions",
      "dashboard_version_snapshots",
      "dashboard_version_evidence",
      "dashboard_artifacts",
      "snapshot_reference_claims",
      "evidence_reference_claims",
      "artifact_reference_claims",
      "snapshot_deletion_finalizers",
      "evidence_deletion_finalizers",
      "artifact_deletion_finalizers",
    ] as const
  ).map((relationName) =>
    columnAcl("dasher_retention_definer", relationName, "SELECT"),
  ),
  ...(
    [
      "dashboard_lifecycle_events",
      "dashboard_cleanup_coordination",
      "dashboard_cleanup_attempts",
      "dashboard_legal_holds",
      "dashboard_tombstones",
      "backup_deletion_ledger",
      "snapshot_reference_claims",
      "evidence_reference_claims",
      "artifact_reference_claims",
      "snapshot_deletion_finalizers",
      "evidence_deletion_finalizers",
      "artifact_deletion_finalizers",
    ] as const
  ).map((relationName) =>
    columnAcl("dasher_retention_definer", relationName, "INSERT"),
  ),
  columnAcl("dasher_retention_definer", "dashboards", "UPDATE", [
    "lifecycle_state",
    "lifecycle_revision",
    "capability_epoch",
    "cache_epoch",
    "access_revoked_at",
    "revocation_reason",
    "purge_after",
    "purge_started_at",
    "purged_at",
  ]),
  columnAcl(
    "dasher_retention_definer",
    "dashboard_cleanup_coordination",
    "UPDATE",
    [
      "current_step",
      "lease_owner",
      "lease_expires_at",
      "expected_lifecycle_revision",
      "next_attempt_at",
      "completion_proof_sha256",
    ],
  ),
  columnAcl("dasher_retention_definer", "dashboard_legal_holds", "UPDATE", [
    "released_at",
    "released_by_principal_id",
    "released_authority_revision",
    "released_actor",
    "released_reason_sha256",
  ]),
  columnAcl("dasher_retention_definer", "dashboard_tombstones", "UPDATE", [
    "purged_at",
    "purged_lifecycle_revision",
    "purged_proof_sha256",
  ]),
  ...(
    [
      "snapshot_deletion_finalizers",
      "evidence_deletion_finalizers",
      "artifact_deletion_finalizers",
    ] as const
  ).map((relationName) =>
    columnAcl("dasher_retention_definer", relationName, "UPDATE", [
      "state",
      "lease_owner",
      "lease_expires_at",
      "proof_sha256",
      "bytes_deleted_at",
    ]),
  ),
  ...(
    [
      "source_snapshots",
      "evidence_records",
      "dashboard_versions",
      "dashboard_version_snapshots",
      "dashboard_version_evidence",
      "dashboard_artifacts",
      "snapshot_reference_claims",
      "evidence_reference_claims",
      "artifact_reference_claims",
    ] as const
  ).map((relationName) =>
    columnAcl("dasher_retention_definer", relationName, "DELETE"),
  ),
] as const;

export const modeled0003RelationAcls = modeled0003EffectiveColumnPrivileges
  .filter((grant) => grant.privilege !== "UPDATE")
  .map((grant) => ({
    role: grant.role,
    relationName: grant.relationName,
    privilege: grant.privilege,
  }));

export const modeled0003ColumnAcls =
  modeled0003EffectiveColumnPrivileges.filter(
    (grant) => grant.privilege === "UPDATE",
  );

function triggerContract(
  name: string,
  relationName: ModeledRelationName,
  functionName:
    | "enforce_dashboard_transition"
    | "enforce_retention_mutation"
    | "reject_dashboard_append_mutation",
  events: readonly ("DELETE" | "INSERT" | "UPDATE")[],
  requiredProofs: readonly string[],
) {
  return {
    name,
    relationName,
    functionIdentity: `dasher_private.${functionName}()`,
    timing: "BEFORE",
    level: "ROW",
    events,
    enabled: "O",
    definition: `CREATE TRIGGER ${name} BEFORE ${events.join(" OR ")} ON dasher.${relationName} FOR EACH ROW EXECUTE FUNCTION dasher_private.${functionName}()`,
    requiredProofs,
    callStackInspection: false,
    dynamicSql: false,
  } as const;
}

const appendOnlyProofs = ["INSERT only; UPDATE and DELETE reject"] as const;
const retentionMutationProofs = [
  "current_user = dasher_retention_definer",
  "phase = authorized",
  "exact principal revision and capability",
  "exact organization and dashboard context",
  "expected lifecycle revision",
  "allowed OLD to NEW transition",
  "exact changed-column allowlist",
] as const;

export const modeled0003Triggers = [
  triggerContract(
    "dashboard_lifecycle_policies_immutable",
    "dashboard_lifecycle_policies",
    "reject_dashboard_append_mutation",
    ["UPDATE", "DELETE"],
    appendOnlyProofs,
  ),
  triggerContract(
    "dashboard_lifecycle_events_immutable",
    "dashboard_lifecycle_events",
    "reject_dashboard_append_mutation",
    ["UPDATE", "DELETE"],
    appendOnlyProofs,
  ),
  triggerContract(
    "dashboard_promotion_requests_immutable",
    "dashboard_promotion_requests",
    "reject_dashboard_append_mutation",
    ["UPDATE", "DELETE"],
    appendOnlyProofs,
  ),
  triggerContract(
    "dashboard_promotion_decisions_immutable",
    "dashboard_promotion_decisions",
    "reject_dashboard_append_mutation",
    ["UPDATE", "DELETE"],
    appendOnlyProofs,
  ),
  triggerContract(
    "dashboard_cleanup_attempts_immutable",
    "dashboard_cleanup_attempts",
    "reject_dashboard_append_mutation",
    ["UPDATE", "DELETE"],
    appendOnlyProofs,
  ),
  triggerContract(
    "dashboard_restore_lineage_immutable",
    "dashboard_restore_lineage",
    "reject_dashboard_append_mutation",
    ["UPDATE", "DELETE"],
    appendOnlyProofs,
  ),
  triggerContract(
    "backup_deletion_ledger_immutable",
    "backup_deletion_ledger",
    "reject_dashboard_append_mutation",
    ["UPDATE", "DELETE"],
    appendOnlyProofs,
  ),
  triggerContract(
    "retention_service_principal_allowlist_immutable",
    "retention_service_principal_allowlist",
    "reject_dashboard_append_mutation",
    ["UPDATE", "DELETE"],
    appendOnlyProofs,
  ),
  triggerContract(
    "dashboards_transition_guard",
    "dashboards",
    "enforce_dashboard_transition",
    ["UPDATE"],
    retentionMutationProofs,
  ),
  triggerContract(
    "dashboard_tombstones_retention_guard",
    "dashboard_tombstones",
    "enforce_retention_mutation",
    ["UPDATE", "DELETE"],
    retentionMutationProofs,
  ),
  triggerContract(
    "source_snapshots_retention_guard",
    "source_snapshots",
    "enforce_retention_mutation",
    ["UPDATE", "DELETE"],
    retentionMutationProofs,
  ),
  triggerContract(
    "evidence_records_retention_guard",
    "evidence_records",
    "enforce_retention_mutation",
    ["UPDATE", "DELETE"],
    retentionMutationProofs,
  ),
  triggerContract(
    "dashboard_versions_retention_guard",
    "dashboard_versions",
    "enforce_retention_mutation",
    ["UPDATE", "DELETE"],
    retentionMutationProofs,
  ),
  triggerContract(
    "dashboard_version_snapshots_retention_guard",
    "dashboard_version_snapshots",
    "enforce_retention_mutation",
    ["UPDATE", "DELETE"],
    retentionMutationProofs,
  ),
  triggerContract(
    "dashboard_version_evidence_retention_guard",
    "dashboard_version_evidence",
    "enforce_retention_mutation",
    ["UPDATE", "DELETE"],
    retentionMutationProofs,
  ),
  triggerContract(
    "dashboard_artifacts_retention_guard",
    "dashboard_artifacts",
    "enforce_retention_mutation",
    ["UPDATE", "DELETE"],
    retentionMutationProofs,
  ),
  triggerContract(
    "snapshot_reference_claims_retention_guard",
    "snapshot_reference_claims",
    "enforce_retention_mutation",
    ["UPDATE", "DELETE"],
    retentionMutationProofs,
  ),
  triggerContract(
    "evidence_reference_claims_retention_guard",
    "evidence_reference_claims",
    "enforce_retention_mutation",
    ["UPDATE", "DELETE"],
    retentionMutationProofs,
  ),
  triggerContract(
    "artifact_reference_claims_retention_guard",
    "artifact_reference_claims",
    "enforce_retention_mutation",
    ["UPDATE", "DELETE"],
    retentionMutationProofs,
  ),
] as const;

function checkConstraint(
  name: string,
  relation: ModeledRelationName | "audit_events",
  definition: string,
  columns: readonly string[],
) {
  return {
    name,
    relation,
    type: "CHECK",
    columns,
    definition,
    deferrable: false,
    initiallyDeferred: false,
    validated: true,
  } as const;
}

const expandedAuditActions = [
  "membership.role_changed",
  "membership.revoked",
  "invitation.issued",
  "invitation.revoked",
  "invitation.accepted",
  "invitation.accepted_existing_membership",
  "session.issued",
  "session.rotated",
  "session.revoked",
  "source_snapshot.created",
  "evidence_record.created",
  "dashboard.created",
  "dashboard_version.created",
  "dashboard_head.promoted",
  "dashboard.promotion_requested",
  "dashboard.promotion_approved",
  "dashboard.promotion_denied",
  "dashboard.expired",
  "dashboard.archived",
  "dashboard.unarchived",
  "dashboard.deleted",
  "dashboard.restored_as_new",
  "dashboard.cleanup_started",
  "dashboard.purge_eligible",
  "dashboard.legal_hold_placed",
  "dashboard.legal_hold_released",
  "dashboard.purged",
  "dashboard.artifact_created",
] as const;

export const modeled0003CheckConstraints = [
  checkConstraint(
    "audit_events_action_check",
    "audit_events",
    `CHECK (((action)::text = ANY ((ARRAY[${expandedAuditActions
      .map((action) => `'${action}'::character varying`)
      .join(", ")}])::text[])))`,
    ["action"],
  ),
  checkConstraint(
    "dashboard_lifecycle_policies_default_ttl_check",
    "dashboard_lifecycle_policies",
    "CHECK (((default_disposable_ttl_seconds >= 3600) AND (default_disposable_ttl_seconds <= 604800)))",
    ["default_disposable_ttl_seconds"],
  ),
  checkConstraint(
    "dashboards_kind_check",
    "dashboards",
    "CHECK (((created_kind = ANY (ARRAY['disposable'::text, 'durable'::text])) AND (current_kind = ANY (ARRAY['disposable'::text, 'durable'::text]))))",
    ["created_kind", "current_kind"],
  ),
  checkConstraint(
    "dashboards_lifecycle_state_check",
    "dashboards",
    "CHECK ((lifecycle_state = ANY (ARRAY['draft'::text, 'active'::text, 'archived'::text, 'access_revoked'::text, 'quarantined'::text, 'purge_eligible'::text, 'cleaned'::text])))",
    ["lifecycle_state"],
  ),
  checkConstraint(
    "dashboards_lifecycle_fences_check",
    "dashboards",
    "CHECK (((lifecycle_revision >= 0) AND (capability_epoch >= 0) AND (cache_epoch >= 0) AND (retention_policy_revision >= 1)))",
    [
      "lifecycle_revision",
      "capability_epoch",
      "cache_epoch",
      "retention_policy_revision",
    ],
  ),
  checkConstraint(
    "dashboards_expiry_kind_check",
    "dashboards",
    "CHECK (((created_kind = 'durable'::text) AND (current_kind = 'durable'::text) AND (original_expires_at IS NULL) AND (effective_expires_at IS NULL) OR ((created_kind = 'disposable'::text) AND (original_expires_at IS NOT NULL) AND (((current_kind = 'disposable'::text) AND (effective_expires_at = original_expires_at)) OR ((current_kind = 'durable'::text) AND (effective_expires_at IS NULL))))))",
    [
      "created_kind",
      "current_kind",
      "original_expires_at",
      "effective_expires_at",
    ],
  ),
  checkConstraint(
    "dashboards_revocation_fields_check",
    "dashboards",
    "CHECK (((access_revoked_at IS NULL) = (revocation_reason IS NULL)))",
    ["access_revoked_at", "revocation_reason"],
  ),
  checkConstraint(
    "dashboard_lifecycle_events_kind_check",
    "dashboard_lifecycle_events",
    "CHECK ((event_kind = ANY (ARRAY['head_activated'::text, 'head_advanced'::text, 'promotion_approved'::text, 'archived'::text, 'unarchived'::text, 'expired'::text, 'deleted'::text, 'cleanup_started'::text, 'purge_eligible'::text, 'legal_hold_placed'::text, 'legal_hold_released'::text, 'purged'::text])))",
    ["event_kind"],
  ),
  checkConstraint(
    "dashboard_promotion_decisions_decision_check",
    "dashboard_promotion_decisions",
    "CHECK ((decision = ANY (ARRAY['approved'::text, 'denied'::text])))",
    ["decision"],
  ),
  checkConstraint(
    "retention_allowlist_binding_kind_check",
    "retention_service_principal_allowlist",
    "CHECK ((binding_kind = 'postgres_session_user'::text))",
    ["binding_kind"],
  ),
  checkConstraint(
    "retention_allowlist_authority_scope_check",
    "retention_service_principal_allowlist",
    "CHECK ((authority_scope = ANY (ARRAY['platform_operator'::text, 'tenant_legal_admin'::text])))",
    ["authority_scope"],
  ),
  checkConstraint(
    "retention_allowlist_scope_check",
    "retention_service_principal_allowlist",
    "CHECK ((((authority_scope = 'platform_operator'::text) AND (scope_organization_id IS NULL)) OR ((authority_scope = 'tenant_legal_admin'::text) AND (scope_organization_id IS NOT NULL))))",
    ["authority_scope", "scope_organization_id"],
  ),
  checkConstraint(
    "retention_allowlist_predecessor_check",
    "retention_service_principal_allowlist",
    "CHECK (((principal_revision = 1) = ((predecessor_revision IS NULL) AND (predecessor_sha256 IS NULL))))",
    ["principal_revision", "predecessor_revision", "predecessor_sha256"],
  ),
  checkConstraint(
    "source_snapshots_source_kind_check",
    "source_snapshots",
    "CHECK ((source_kind = ANY (ARRAY['synthetic_fixture'::text, 'public_usgs_fixture'::text])))",
    ["source_kind"],
  ),
  checkConstraint(
    "source_snapshots_canonical_bytes_length_check",
    "source_snapshots",
    "CHECK (((octet_length(canonical_bytes) >= 1) AND (octet_length(canonical_bytes) <= 1048576)))",
    ["canonical_bytes"],
  ),
  checkConstraint(
    "evidence_records_evidence_kind_check",
    "evidence_records",
    "CHECK ((evidence_kind = ANY (ARRAY['source_record'::text, 'typed_value'::text, 'calculation_result'::text, 'event_record'::text])))",
    ["evidence_kind"],
  ),
  checkConstraint(
    "dashboard_versions_validation_state_check",
    "dashboard_versions",
    "CHECK ((validation_state = 'validated'::text))",
    ["validation_state"],
  ),
  checkConstraint(
    "dashboard_artifacts_ownership_class_check",
    "dashboard_artifacts",
    "CHECK ((ownership_class = ANY (ARRAY['dashboard_owned'::text, 'shared'::text])))",
    ["ownership_class"],
  ),
  ...(
    [
      "snapshot_reference_claims",
      "evidence_reference_claims",
      "artifact_reference_claims",
    ] as const
  ).flatMap((relationName) => [
    checkConstraint(
      `${relationName}_claim_kind_check`,
      relationName,
      "CHECK ((claim_kind = ANY (ARRAY['access_bearing'::text, 'retention_only'::text])))",
      ["claim_kind"],
    ),
    checkConstraint(
      `${relationName}_hold_check`,
      relationName,
      "CHECK ((((claim_kind = 'access_bearing'::text) AND (hold_id IS NULL)) OR ((claim_kind = 'retention_only'::text) AND (hold_id IS NOT NULL))))",
      ["claim_kind", "hold_id"],
    ),
  ]),
  ...(
    [
      "snapshot_deletion_finalizers",
      "evidence_deletion_finalizers",
      "artifact_deletion_finalizers",
    ] as const
  ).map((relationName) =>
    checkConstraint(
      `${relationName}_state_check`,
      relationName,
      "CHECK ((state = ANY (ARRAY['intent'::text, 'eligible'::text, 'deleted'::text])))",
      ["state"],
    ),
  ),
] as const;

export const modeled0003CatalogMatrix = {
  schemas: [
    {
      name: "dasher_retention_api",
      owner,
      acl: [
        {
          grantor: owner,
          grantee: owner,
          privilege: "CREATE",
          isGrantable: false,
        },
        {
          grantor: owner,
          grantee: owner,
          privilege: "USAGE",
          isGrantable: false,
        },
        {
          grantor: owner,
          grantee: "dasher_retention_operator",
          privilege: "USAGE",
          isGrantable: false,
        },
      ],
    },
  ],
  relations: modeled0003Relations,
  relationCatalog: Object.keys(modeled0003Relations).map((name) => ({
    schema: "dasher",
    name,
    kind: "r",
    owner,
    persistence: "p",
    rowSecurity: true,
    forceRowSecurity: true,
    replicaIdentity: "d",
    options: [] as readonly string[],
  })),
  columns: modeled0003ColumnCatalog,
  types: [
    ...Object.entries(modeled0003ReturnColumns).map(([name, definition]) => ({
      schema: "dasher",
      name: name.slice("dasher.".length),
      kind: "c",
      category: "C",
      owner,
      relation: name.slice("dasher.".length),
      definition,
      acl: [
        {
          grantor: owner,
          grantee: owner,
          privilege: "USAGE",
          isGrantable: false,
        },
      ],
    })),
    ...Object.entries(modeled0003Relations).map(
      ([relationName, relationInventory]) => ({
        schema: "dasher",
        name: relationName,
        kind: "c",
        category: "C",
        owner,
        relation: relationName,
        definition: relationInventory.columns.map((columnName) => {
          const column = modeled0003ColumnCatalog.find(
            (candidate) =>
              candidate.relationName === relationName &&
              candidate.columnName === columnName,
          );
          if (column === undefined) {
            throw new Error(
              `missing modeled composite column: ${relationName}.${columnName}`,
            );
          }
          return `${columnName} ${column.type}`;
        }),
        acl: [
          {
            grantor: owner,
            grantee: owner,
            privilege: "USAGE",
            isGrantable: false,
          },
        ],
      }),
    ),
  ],
  sequences: [],
  indexes: [
    ...Object.entries(modeled0003Relations).map(([name, value]) => ({
      name: `${name}_pkey`,
      relation: name,
      method: "btree",
      unique: true,
      primary: true,
      keyExpressions: value.primaryKey,
      opclasses: value.primaryKey.map((columnName) => {
        const column = modeled0003ColumnCatalog.find(
          (candidate) =>
            candidate.relationName === name &&
            candidate.columnName === columnName,
        );
        if (column === undefined) {
          throw new Error(
            `missing modeled index column: ${name}.${columnName}`,
          );
        }
        return column.type === "uuid"
          ? "uuid_ops"
          : column.type === "bigint"
            ? "int8_ops"
            : column.type === "integer"
              ? "int4_ops"
              : column.type === "name"
                ? "name_ops"
                : "text_ops";
      }),
      predicate: null as string | null,
      valid: true,
      ready: true,
      live: true,
      nullsNotDistinct: false,
      options: value.primaryKey.map(() => 0),
    })),
    ...modeled0003ForeignKeys.map((constraint) => ({
      name: `${constraint.name}_idx`,
      relation: constraint.relation,
      method: "btree",
      unique: false,
      primary: false,
      keyExpressions: constraint.columns,
      opclasses: constraint.columns.map(() => "uuid_ops"),
      predicate: null as string | null,
      valid: true,
      ready: true,
      live: true,
      nullsNotDistinct: false,
      options: constraint.columns.map(() => 0),
    })),
    {
      name: "dashboards_effective_expiry_idx",
      relation: "dashboards",
      method: "btree",
      unique: false,
      primary: false,
      keyExpressions: [
        "effective_expires_at",
        "organization_id",
        "dashboard_id",
      ],
      opclasses: ["timestamptz_ops", "uuid_ops", "uuid_ops"],
      predicate:
        "((current_kind = 'disposable'::text) AND (access_revoked_at IS NULL) AND (purged_at IS NULL))",
      valid: true,
      ready: true,
      live: true,
      nullsNotDistinct: false,
      options: [0, 0, 0],
    },
    {
      name: "dashboards_purge_after_idx",
      relation: "dashboards",
      method: "btree",
      unique: false,
      primary: false,
      keyExpressions: ["purge_after", "organization_id", "dashboard_id"],
      opclasses: ["timestamptz_ops", "uuid_ops", "uuid_ops"],
      predicate: "((purged_at IS NULL) AND (purge_after IS NOT NULL))",
      valid: true,
      ready: true,
      live: true,
      nullsNotDistinct: false,
      options: [0, 0, 0],
    },
    {
      name: "dashboard_cleanup_coordination_next_attempt_idx",
      relation: "dashboard_cleanup_coordination",
      method: "btree",
      unique: false,
      primary: false,
      keyExpressions: ["next_attempt_at", "organization_id", "dashboard_id"],
      opclasses: ["timestamptz_ops", "uuid_ops", "uuid_ops"],
      predicate: null,
      valid: true,
      ready: true,
      live: true,
      nullsNotDistinct: false,
      options: [0, 0, 0],
    },
    {
      name: "dashboard_legal_holds_active_idx",
      relation: "dashboard_legal_holds",
      method: "btree",
      unique: false,
      primary: false,
      keyExpressions: ["organization_id", "dashboard_id", "hold_id"],
      opclasses: ["uuid_ops", "uuid_ops", "uuid_ops"],
      predicate: "released_at IS NULL",
      valid: true,
      ready: true,
      live: true,
      nullsNotDistinct: false,
      options: [0, 0, 0],
    },
  ],
  constraints: [
    ...Object.entries(modeled0003Relations).map(([name, value]) => ({
      name: `${name}_pkey`,
      relation: name,
      type: "PRIMARY KEY",
      columns: value.primaryKey,
      definition: `PRIMARY KEY (${value.primaryKey.join(", ")})`,
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
    })),
    ...modeled0003ForeignKeys,
    ...modeled0003CheckConstraints,
  ],
  triggers: modeled0003Triggers,
  policies: modeled0003Policies,
  functions: modeled0003Functions,
  returnColumns: modeled0003ReturnColumns,
  relationAcls: modeled0003RelationAcls,
  catalogRelationAcls: modeled0003RelationAcls.map((acl) => ({
    schema: "dasher",
    relationName: acl.relationName,
    grantor: owner,
    grantee: acl.role,
    privilege: acl.privilege,
    isGrantable: false,
  })),
  effectiveColumnPrivileges: modeled0003EffectiveColumnPrivileges,
  aclClosure: {
    public: [],
    dasher_app: [],
    dasher_retention_operator: [],
    allowlistRuntimeMutations: [],
    allowedPrivilegeKinds: ["SELECT", "INSERT", "UPDATE", "DELETE"],
    grantsAreColumnScopedOnlyForUpdate: true,
  },
  functionExecuteGrants: modeled0003Functions.map((routine) => ({
    identity: `${routine.schema}.${routine.name}(${routine.identityArguments})`,
    grantor: routine.owner,
    grantees: routine.execute,
    isGrantable: false,
  })),
  columnAcls: modeled0003ColumnAcls,
  catalogColumnAcls: modeled0003ColumnAcls.flatMap((acl) =>
    acl.columns.map((columnName) => ({
      schema: "dasher",
      relationName: acl.relationName,
      columnName,
      grantor: owner,
      grantee: acl.role,
      privilege: acl.privilege,
      isGrantable: false,
    })),
  ),
  dependencyInventory: {
    preparedPrefix: [],
    successorOwners: [
      "dasher_security_definer owns exactly sixteen new dasher_api functions",
      "dasher_retention_definer owns exactly seven dasher_retention_api functions",
    ],
    successorAclDependencies: [
      "dasher_app has execute on exactly sixteen new dasher_api functions",
      "dasher_retention_operator has execute on exactly seven retention functions",
      "dasher_retention_definer has only exact column-scoped transition privileges",
    ],
    defaultAcls: [],
    memberships: [],
    otherPgShdepend: [],
  },
} as const;

export const modeled0003SafetyMatrix = {
  canonicalBytesMaximum: 1_048_576,
  canonicalBytesMinimum: 1,
  sourceKinds: ["synthetic_fixture", "public_usgs_fixture"],
  includesCredentials: false,
  includesNetworkOperations: false,
  includesProviders: false,
  includesProductSideEffects: false,
  usesDynamicSql: false,
  bootstrapSelectPolicyNames: modeled0003Policies
    .filter((policy) => policy.bootstrap)
    .map((policy) => policy.name),
  allowlistRuntimePrivileges: ["SELECT"],
  transactionIsolation: "read committed",
  initializerVolatility: "VOLATILE",
  initializerProvolatile: "v",
  initializerSecurityDefiner: true,
  initializerProconfig: ["search_path=pg_catalog"],
} as const;

function assertUniqueIdentities(
  category: string,
  identities: readonly string[],
): void {
  if (new Set(identities).size !== identities.length) {
    throw new Error(`duplicate modeled ${category} catalog identity`);
  }
}

function assertModeled0003InventoryInvariants(): void {
  const predecessorColumns: Readonly<Record<string, readonly string[]>> = {
    audit_events: ["action"],
    organizations: ["organization_id"],
    users: ["user_id"],
  };
  const relationEntries = Object.entries(modeled0003Relations);
  const relationNames = new Set(relationEntries.map(([name]) => name));

  assertUniqueIdentities(
    "relation",
    modeled0003CatalogMatrix.relationCatalog.map(
      (relationRow) => `${relationRow.schema}.${relationRow.name}`,
    ),
  );
  assertUniqueIdentities(
    "column",
    modeled0003ColumnCatalog.map(
      (column) => `${column.relationName}.${column.columnName}`,
    ),
  );

  for (const [relationName, inventory] of relationEntries) {
    assertUniqueIdentities(
      `${relationName} column`,
      inventory.columns.map((columnName) => `${relationName}.${columnName}`),
    );
    for (const primaryKeyColumn of inventory.primaryKey) {
      const matchingColumns = modeled0003ColumnCatalog.filter(
        (column) =>
          column.relationName === relationName &&
          column.columnName === primaryKeyColumn,
      );
      if (matchingColumns.length !== 1 || matchingColumns[0]?.nullable) {
        throw new Error(
          `modeled primary key column must exist once and be non-null: ${relationName}.${primaryKeyColumn}`,
        );
      }
    }
  }

  for (const foreignKeyRow of modeled0003ForeignKeys) {
    const source = modeled0003Relations[foreignKeyRow.relation];
    const target = relationNames.has(foreignKeyRow.targetRelation)
      ? modeled0003Relations[
          foreignKeyRow.targetRelation as ModeledRelationName
        ].columns
      : predecessorColumns[foreignKeyRow.targetRelation];
    if (
      foreignKeyRow.columns.length !== foreignKeyRow.targetColumns.length ||
      foreignKeyRow.columns.some(
        (column) => !source.columns.includes(column),
      ) ||
      target === undefined ||
      foreignKeyRow.targetColumns.some((column) => !target.includes(column))
    ) {
      throw new Error(`unresolved modeled foreign key: ${foreignKeyRow.name}`);
    }
  }

  for (const checkRow of modeled0003CheckConstraints) {
    const columns = relationNames.has(checkRow.relation)
      ? modeled0003Relations[checkRow.relation as ModeledRelationName].columns
      : predecessorColumns[checkRow.relation];
    if (
      columns === undefined ||
      checkRow.columns.some((column) => !columns.includes(column))
    ) {
      throw new Error(`unresolved modeled check: ${checkRow.name}`);
    }
  }

  for (const indexRow of modeled0003CatalogMatrix.indexes) {
    const columns =
      modeled0003Relations[indexRow.relation as ModeledRelationName].columns;
    if (
      indexRow.keyExpressions.some(
        (expression) => !columns.includes(expression),
      )
    ) {
      throw new Error(`unresolved modeled index: ${indexRow.name}`);
    }
  }
  for (const triggerRow of modeled0003Triggers) {
    if (!relationNames.has(triggerRow.relationName)) {
      throw new Error(`unresolved modeled trigger: ${triggerRow.name}`);
    }
  }
  for (const policyRow of modeled0003Policies) {
    if (!relationNames.has(policyRow.relation)) {
      throw new Error(`unresolved modeled policy: ${policyRow.name}`);
    }
  }

  assertUniqueIdentities(
    "index",
    modeled0003CatalogMatrix.indexes.map(
      (indexRow) => `dasher.${indexRow.name}`,
    ),
  );
  assertUniqueIdentities(
    "constraint",
    modeled0003CatalogMatrix.constraints.map(
      (constraintRow) =>
        `dasher.${constraintRow.relation}.${constraintRow.name}`,
    ),
  );
  assertUniqueIdentities(
    "trigger",
    modeled0003Triggers.map(
      (triggerRow) => `dasher.${triggerRow.relationName}.${triggerRow.name}`,
    ),
  );
  assertUniqueIdentities(
    "policy",
    modeled0003Policies.map(
      (policyRow) => `dasher.${policyRow.relation}.${policyRow.name}`,
    ),
  );
  assertUniqueIdentities(
    "function",
    modeled0003Functions.map(
      (routine) =>
        `${routine.schema}.${routine.name}(${routine.identityArguments})`,
    ),
  );
  assertUniqueIdentities(
    "type",
    modeled0003CatalogMatrix.types.map(
      (typeRow) => `${typeRow.schema}.${typeRow.name}`,
    ),
  );
}

assertModeled0003InventoryInvariants();
