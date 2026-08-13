-- Dasher agent-run operator reachability and Replay-fence correction.
-- Governing plan: Task 9D R7 closure amendment, 2026-08-12.



-- Phase 12 closes only the policy seams enumerated by the governing R7
-- amendment. Immutable content remains nonlocking and receives no new UPDATE
-- authority. Every predecessor arm below is derived from frozen 0007 or 0011.
REVOKE UPDATE (catalog_snapshot_id)
  ON TABLE dasher.field_catalog_snapshots FROM dasher_run_definer;
REVOKE UPDATE (contract_id)
  ON TABLE dasher.metric_contract_versions FROM dasher_run_definer;
REVOKE UPDATE (organization_id, dashboard_id, version_id)
  ON TABLE dasher.dashboard_versions FROM dasher_run_definer;
DROP POLICY dashboard_versions_run_lock_update ON dasher.dashboard_versions;

ALTER POLICY memberships_run_reauthorization_select
ON dasher.memberships
USING (
  (
    current_user = 'dasher_run_definer'::name
      AND current_setting('dasher.run_phase', true) IN ('locking', 'authorized', 'checkpoint_replay')
      AND organization_id = NULLIF(current_setting('dasher.run_organization_id', true), '')::uuid
      AND membership_id = NULLIF(current_setting('dasher.run_membership_id', true), '')::uuid
      AND user_id = NULLIF(current_setting('dasher.run_user_id', true), '')::uuid
      AND authority_revision = NULLIF(current_setting(
        'dasher.run_authority_revision', true
      ), '')::bigint
  ) OR (
    ((
      current_setting('dasher.run_phase', true) = 'locking'
      AND current_user = 'dasher_run_definer'::name
      AND NULLIF(current_setting(
        'dasher.run_capability', true
      ), '') = ANY(ARRAY[
        'read_input','clone_replay','read_replay','consume_replay','checkpoint',
        'commit_graph','commit_candidate','close_candidate_set',
        'commit_validation','commit_claims','commit_manifest',
        'commit_abstention','finalize_ranking','finish'
      ]::text[])
    ) OR (
      current_user = 'dasher_run_definer'::name
      AND current_setting(
        'dasher.run_phase', true
      ) = 'request_replay_locking'
      AND NULLIF(current_setting('dasher.run_capability', true), '')
        = 'replay_source_fence_request'
      AND NULLIF(current_setting('dasher.security_function', true), '')
        = 'request_agent_run'
    ))
    AND organization_id = NULLIF(current_setting(
      'dasher.run_organization_id', true
    ), '')::uuid
    AND membership_id = NULLIF(current_setting(
      'dasher.run_lock_membership_id', true
    ), '')::uuid
    AND user_id = NULLIF(current_setting(
      'dasher.run_lock_user_id', true
    ), '')::uuid
    AND authority_revision = NULLIF(current_setting(
      'dasher.run_lock_authority_revision', true
    ), '')::bigint
  )
);

ALTER POLICY memberships_run_reauthorization_lock
ON dasher.memberships
USING (
  (
    current_user = 'dasher_run_definer'::name
      AND current_setting('dasher.run_phase', true) = 'locking'
      AND organization_id = NULLIF(current_setting('dasher.run_organization_id', true), '')::uuid
      AND membership_id = NULLIF(current_setting('dasher.run_membership_id', true), '')::uuid
  ) OR (
    ((
      current_setting('dasher.run_phase', true) = 'locking'
      AND current_user = 'dasher_run_definer'::name
      AND NULLIF(current_setting(
        'dasher.run_capability', true
      ), '') = ANY(ARRAY[
        'read_input','clone_replay','read_replay','consume_replay','checkpoint',
        'commit_graph','commit_candidate','close_candidate_set',
        'commit_validation','commit_claims','commit_manifest',
        'commit_abstention','finalize_ranking','finish'
      ]::text[])
    ) OR (
      current_user = 'dasher_run_definer'::name
      AND current_setting(
        'dasher.run_phase', true
      ) = 'request_replay_locking'
      AND NULLIF(current_setting('dasher.run_capability', true), '')
        = 'replay_source_fence_request'
      AND NULLIF(current_setting('dasher.security_function', true), '')
        = 'request_agent_run'
    ))
    AND organization_id = NULLIF(current_setting(
      'dasher.run_organization_id', true
    ), '')::uuid
    AND membership_id = NULLIF(current_setting(
      'dasher.run_lock_membership_id', true
    ), '')::uuid
  )
)
WITH CHECK (false);

ALTER POLICY dashboard_lifecycle_policies_run_select
ON dasher.dashboard_lifecycle_policies
USING (
  (
    current_user = 'dasher_run_definer'::name
      AND current_setting('dasher.run_phase', true) IN ('locking', 'authorized', 'checkpoint_replay')
      AND NULLIF(current_setting(
        'dasher.run_capability', true
      ), '') = ANY(ARRAY[
        'checkpoint', 'claim', 'clone_replay', 'close_candidate_set',
        'commit_abstention', 'commit_brief', 'commit_bundle', 'commit_candidate',
        'commit_claims', 'commit_graph', 'commit_manifest', 'commit_validation',
        'consume_replay', 'dispatch', 'finalize_ranking', 'finish', 'read_input',
        'read_replay', 'reconcile', 'release', 'reserve'
      ]::text[])
      AND COALESCE(current_setting('dasher.run_principal_id', true), '') <> ''
      AND COALESCE(current_setting(
        'dasher.run_principal_revision', true
      ), '') <> ''
      AND EXISTS (
        SELECT 1
        FROM dasher.run_service_principal_allowlist AS principal
        WHERE principal.run_service_principal_id = NULLIF(current_setting(
            'dasher.run_principal_id', true
          ), '')::uuid
          AND principal.principal_revision = NULLIF(current_setting(
            'dasher.run_principal_revision', true
          ), '')::bigint
          AND principal.session_login = session_user
          AND principal.database_name = pg_catalog.current_database()
          AND principal.enabled
          AND NULLIF(current_setting(
            'dasher.run_capability', true
          ), '') = ANY(principal.capabilities)
          AND NOT EXISTS (
            SELECT 1
            FROM dasher.run_service_principal_allowlist AS later
            WHERE later.run_service_principal_id
              = principal.run_service_principal_id
              AND later.principal_revision > principal.principal_revision
          )
      )
      AND organization_id = NULLIF(current_setting('dasher.run_organization_id', true), '')::uuid
  ) OR (
    current_user = 'dasher_run_definer'::name
      AND current_setting(
        'dasher.run_phase', true
      ) = 'request_replay_locking'
      AND NULLIF(current_setting('dasher.run_capability', true), '')
        = 'replay_source_fence_request'
      AND NULLIF(current_setting('dasher.security_function', true), '')
        = 'request_agent_run'
    AND organization_id = NULLIF(current_setting(
      'dasher.run_organization_id', true
    ), '')::uuid
  )
);

ALTER POLICY dashboard_lifecycle_policies_run_lock_update
ON dasher.dashboard_lifecycle_policies
USING (
  (
    current_user = 'dasher_run_definer'::name
      AND current_setting('dasher.run_phase', true) = 'locking'
      AND organization_id = NULLIF(current_setting('dasher.run_organization_id', true), '')::uuid
  ) OR (
    current_user = 'dasher_run_definer'::name
      AND current_setting(
        'dasher.run_phase', true
      ) = 'request_replay_locking'
      AND NULLIF(current_setting('dasher.run_capability', true), '')
        = 'replay_source_fence_request'
      AND NULLIF(current_setting('dasher.security_function', true), '')
        = 'request_agent_run'
    AND organization_id = NULLIF(current_setting(
      'dasher.run_organization_id', true
    ), '')::uuid
  )
)
WITH CHECK (false);

ALTER POLICY agent_run_policy_revisions_run_definer_select
ON dasher.agent_run_policy_revisions
USING (
  (
    current_user = 'dasher_run_definer'::name
      AND current_setting('dasher.run_phase', true) IN ('locking','authorized','checkpoint_replay')
      AND COALESCE(current_setting('dasher.run_principal_id', true), '') <> ''
      AND COALESCE(current_setting(
        'dasher.run_principal_revision', true
      ), '') <> ''
      AND COALESCE(current_setting('dasher.run_capability', true), '') <> ''
      AND policy_revision >= NULLIF(current_setting(
        'dasher.run_policy_revision', true
      ), '')::bigint
  ) OR (
    current_user = 'dasher_run_definer'::name
      AND current_setting(
        'dasher.run_phase', true
      ) = 'request_replay_locking'
      AND NULLIF(current_setting('dasher.run_capability', true), '')
        = 'replay_source_fence_request'
      AND NULLIF(current_setting('dasher.security_function', true), '')
        = 'request_agent_run'
    AND policy_revision = NULLIF(current_setting(
      'dasher.run_policy_revision', true
    ), '')::bigint
  )
);

ALTER POLICY agent_run_policy_revisions_run_lock_update
ON dasher.agent_run_policy_revisions
USING (
  (
    (
        current_user = 'dasher_run_definer'::name
        AND current_setting('dasher.run_phase', true) IN ('locking','authorized')
        AND policy_revision = NULLIF(current_setting(
          'dasher.run_policy_revision', true
        ), '')::bigint
      ) OR (
        current_user = 'dasher_security_definer'::name
        AND current_setting('dasher.security_phase', true) = 'authorized'
        AND current_setting('dasher.security_capability', true)
          IN ('request_agent_run', 'cancel_agent_run')
        AND dasher_private.context_allows(
          dasher_private.context_organization_id(), 'editor'
        )
      )
  ) OR (
    current_user = 'dasher_run_definer'::name
      AND current_setting(
        'dasher.run_phase', true
      ) = 'request_replay_locking'
      AND NULLIF(current_setting('dasher.run_capability', true), '')
        = 'replay_source_fence_request'
      AND NULLIF(current_setting('dasher.security_function', true), '')
        = 'request_agent_run'
    AND policy_revision = NULLIF(current_setting(
      'dasher.run_policy_revision', true
    ), '')::bigint
  )
)
WITH CHECK (false);

ALTER POLICY dashboards_run_select
ON dasher.dashboards
USING (
  (
    current_user = 'dasher_run_definer'::name
      AND current_setting('dasher.run_phase', true) IN ('locking', 'authorized', 'checkpoint_replay')
      AND NULLIF(current_setting(
        'dasher.run_capability', true
      ), '') = ANY(ARRAY[
        'checkpoint', 'claim', 'clone_replay', 'close_candidate_set',
        'commit_abstention', 'commit_brief', 'commit_bundle', 'commit_candidate',
        'commit_claims', 'commit_graph', 'commit_manifest', 'commit_validation',
        'consume_replay', 'dispatch', 'finalize_ranking', 'finish', 'read_input',
        'read_replay', 'reconcile', 'release', 'reserve'
      ]::text[])
      AND COALESCE(current_setting('dasher.run_principal_id', true), '') <> ''
      AND COALESCE(current_setting(
        'dasher.run_principal_revision', true
      ), '') <> ''
      AND EXISTS (
        SELECT 1
        FROM dasher.run_service_principal_allowlist AS principal
        WHERE principal.run_service_principal_id = NULLIF(current_setting(
            'dasher.run_principal_id', true
          ), '')::uuid
          AND principal.principal_revision = NULLIF(current_setting(
            'dasher.run_principal_revision', true
          ), '')::bigint
          AND principal.session_login = session_user
          AND principal.database_name = pg_catalog.current_database()
          AND principal.enabled
          AND NULLIF(current_setting(
            'dasher.run_capability', true
          ), '') = ANY(principal.capabilities)
          AND NOT EXISTS (
            SELECT 1
            FROM dasher.run_service_principal_allowlist AS later
            WHERE later.run_service_principal_id
              = principal.run_service_principal_id
              AND later.principal_revision > principal.principal_revision
          )
      )
      AND organization_id = NULLIF(current_setting('dasher.run_organization_id', true), '')::uuid
      AND dashboard_id = NULLIF(current_setting('dasher.run_dashboard_id', true), '')::uuid
  ) OR (
    current_user = 'dasher_run_definer'::name
      AND current_setting(
        'dasher.run_phase', true
      ) = 'request_replay_locking'
      AND NULLIF(current_setting('dasher.run_capability', true), '')
        = 'replay_source_fence_request'
      AND NULLIF(current_setting('dasher.security_function', true), '')
        = 'request_agent_run'
    AND organization_id = NULLIF(current_setting(
      'dasher.run_organization_id', true
    ), '')::uuid
    AND dashboard_id = NULLIF(current_setting(
      'dasher.run_dashboard_id', true
    ), '')::uuid
  )
);

ALTER POLICY dashboards_run_lock_update
ON dasher.dashboards
USING (
  (
    current_user = 'dasher_run_definer'::name
      AND current_setting('dasher.run_phase', true) = 'locking'
      AND organization_id = NULLIF(current_setting('dasher.run_organization_id', true), '')::uuid
      AND dashboard_id = NULLIF(current_setting('dasher.run_dashboard_id', true), '')::uuid
  ) OR (
    current_user = 'dasher_run_definer'::name
      AND current_setting(
        'dasher.run_phase', true
      ) = 'request_replay_locking'
      AND NULLIF(current_setting('dasher.run_capability', true), '')
        = 'replay_source_fence_request'
      AND NULLIF(current_setting('dasher.security_function', true), '')
        = 'request_agent_run'
    AND organization_id = NULLIF(current_setting(
      'dasher.run_organization_id', true
    ), '')::uuid
    AND dashboard_id = NULLIF(current_setting(
      'dasher.run_dashboard_id', true
    ), '')::uuid
  )
)
WITH CHECK (false);

ALTER POLICY agent_runs_run_definer_select
ON dasher.agent_runs
USING (
  (
    dasher_private.run_policy_allows_v1(organization_id, dashboard_id, run_id)
      OR (
        current_user = 'dasher_run_definer'::name
        AND current_setting('dasher.run_phase', true) = 'locking'
        AND organization_id = NULLIF(current_setting(
          'dasher.run_organization_id', true
        ), '')::uuid
        AND dashboard_id = NULLIF(current_setting(
          'dasher.run_dashboard_id', true
        ), '')::uuid
        AND run_id = NULLIF(current_setting('dasher.run_id', true), '')::uuid
      )
      OR (
        current_user = 'dasher_run_definer'::name
        AND current_setting('dasher.run_phase', true) = 'replay_source_read'
        AND organization_id = NULLIF(current_setting(
          'dasher.run_organization_id', true
        ), '')::uuid
        AND dashboard_id = NULLIF(current_setting('dasher.run_dashboard_id', true), '')::uuid
        AND run_id = NULLIF(current_setting('dasher.run_replay_source_id', true), '')::uuid
      )
  ) OR (
    (
      current_setting('dasher.run_phase', true) = 'locking'
      AND current_user = 'dasher_run_definer'::name
      AND NULLIF(current_setting(
        'dasher.run_capability', true
      ), '') = ANY(ARRAY[
        'read_input','clone_replay','read_replay','consume_replay','checkpoint',
        'commit_graph','commit_candidate','close_candidate_set',
        'commit_validation','commit_claims','commit_manifest',
        'commit_abstention','finalize_ranking','finish'
      ]::text[])
      AND organization_id = NULLIF(current_setting(
        'dasher.run_organization_id', true
      ), '')::uuid
      AND dashboard_id = NULLIF(current_setting(
        'dasher.run_dashboard_id', true
      ), '')::uuid
      AND run_id = NULLIF(current_setting(
        'dasher.run_lock_run_id', true
      ), '')::uuid
    ) OR (
      current_user = 'dasher_run_definer'::name
      AND current_setting(
        'dasher.run_phase', true
      ) = 'request_replay_locking'
      AND NULLIF(current_setting('dasher.run_capability', true), '')
        = 'replay_source_fence_request'
      AND NULLIF(current_setting('dasher.security_function', true), '')
        = 'request_agent_run'
      AND organization_id = NULLIF(current_setting(
        'dasher.run_organization_id', true
      ), '')::uuid
      AND dashboard_id = NULLIF(current_setting(
        'dasher.run_dashboard_id', true
      ), '')::uuid
      AND run_id = NULLIF(current_setting(
        'dasher.run_replay_source_id', true
      ), '')::uuid
    )
  )
);

ALTER POLICY agent_runs_run_definer_update
ON dasher.agent_runs
USING (
  (
    dasher_private.run_policy_allows_v1(organization_id, dashboard_id, run_id)
      OR (
        current_user = 'dasher_run_definer'::name
        AND current_setting('dasher.run_phase', true) = 'locking'
        AND organization_id = NULLIF(current_setting(
          'dasher.run_organization_id', true
        ), '')::uuid
        AND dashboard_id = NULLIF(current_setting(
          'dasher.run_dashboard_id', true
        ), '')::uuid
        AND run_id = NULLIF(current_setting('dasher.run_id', true), '')::uuid
      )
      OR (
        current_user = 'dasher_run_definer'::name
        AND current_setting('dasher.run_phase', true) = 'replay_source_read'
        AND organization_id = NULLIF(current_setting(
          'dasher.run_organization_id', true
        ), '')::uuid
        AND dashboard_id = NULLIF(current_setting('dasher.run_dashboard_id', true), '')::uuid
        AND run_id = NULLIF(current_setting('dasher.run_replay_source_id', true), '')::uuid
      )
  ) OR (
    (
      current_setting('dasher.run_phase', true) = 'locking'
      AND current_user = 'dasher_run_definer'::name
      AND NULLIF(current_setting(
        'dasher.run_capability', true
      ), '') = ANY(ARRAY[
        'read_input','clone_replay','read_replay','consume_replay','checkpoint',
        'commit_graph','commit_candidate','close_candidate_set',
        'commit_validation','commit_claims','commit_manifest',
        'commit_abstention','finalize_ranking','finish'
      ]::text[])
      AND organization_id = NULLIF(current_setting(
        'dasher.run_organization_id', true
      ), '')::uuid
      AND dashboard_id = NULLIF(current_setting(
        'dasher.run_dashboard_id', true
      ), '')::uuid
      AND run_id = NULLIF(current_setting(
        'dasher.run_lock_run_id', true
      ), '')::uuid
    ) OR (
      current_user = 'dasher_run_definer'::name
      AND current_setting(
        'dasher.run_phase', true
      ) = 'request_replay_locking'
      AND NULLIF(current_setting('dasher.run_capability', true), '')
        = 'replay_source_fence_request'
      AND NULLIF(current_setting('dasher.security_function', true), '')
        = 'request_agent_run'
      AND organization_id = NULLIF(current_setting(
        'dasher.run_organization_id', true
      ), '')::uuid
      AND dashboard_id = NULLIF(current_setting(
        'dasher.run_dashboard_id', true
      ), '')::uuid
      AND run_id = NULLIF(current_setting(
        'dasher.run_replay_source_id', true
      ), '')::uuid
    )
  )
)
WITH CHECK (dasher_private.run_policy_allows_v1(organization_id, dashboard_id, run_id));

ALTER POLICY agent_runs_run_discovery_select
ON dasher.agent_runs
USING (
  (
    current_user = 'dasher_run_definer'::name
      AND current_setting('dasher.run_phase', true) = 'discovering'
      AND NULLIF(current_setting(
        'dasher.run_capability', true
      ), '') = ANY(ARRAY[
        'checkpoint', 'claim', 'clone_replay', 'close_candidate_set',
        'commit_abstention', 'commit_brief', 'commit_bundle', 'commit_candidate',
        'commit_claims', 'commit_graph', 'commit_manifest', 'commit_validation',
        'consume_replay', 'dispatch', 'finalize_ranking', 'finish', 'read_input',
        'read_replay', 'reconcile', 'release', 'reserve'
      ]::text[])
      AND COALESCE(current_setting('dasher.run_principal_id', true), '') <> ''
      AND COALESCE(current_setting(
        'dasher.run_principal_revision', true
      ), '') <> ''
      AND (
        state IN (
          'requested','authorized','planning','generating','validating','revising'
        )
        OR (
          state = 'failed'
          AND NULLIF(current_setting(
            'dasher.run_capability', true
          ), '') = 'reconcile'
        )
      )
      AND EXISTS (
        SELECT 1
        FROM dasher.run_service_principal_allowlist AS principal
        WHERE principal.run_service_principal_id = NULLIF(current_setting(
            'dasher.run_principal_id', true
          ), '')::uuid
          AND principal.principal_revision = NULLIF(current_setting(
            'dasher.run_principal_revision', true
          ), '')::bigint
          AND principal.session_login = session_user
          AND principal.database_name = pg_catalog.current_database()
          AND principal.enabled
          AND NULLIF(current_setting(
            'dasher.run_capability', true
          ), '') = ANY(principal.capabilities)
          AND NOT EXISTS (
            SELECT 1
            FROM dasher.run_service_principal_allowlist AS later
            WHERE later.run_service_principal_id
              = principal.run_service_principal_id
              AND later.principal_revision > principal.principal_revision
          )
      )
  ) OR   (
    current_user = 'dasher_run_definer'::name
      AND current_setting('dasher.run_phase', true) = 'replay_discovering'
      AND run_id = NULLIF(current_setting(
        'dasher.run_replay_source_id', true
      ), '')::uuid
      AND NULLIF(current_setting(
        'dasher.run_capability', true
      ), '') = ANY(ARRAY[
        'checkpoint', 'claim', 'clone_replay', 'close_candidate_set',
        'commit_abstention', 'commit_brief', 'commit_bundle', 'commit_candidate',
        'commit_claims', 'commit_graph', 'commit_manifest', 'commit_validation',
        'consume_replay', 'dispatch', 'finalize_ranking', 'finish', 'read_input',
        'read_replay', 'reconcile', 'release', 'reserve'
      ]::text[])
      AND COALESCE(current_setting('dasher.run_principal_id', true), '') <> ''
      AND COALESCE(current_setting(
        'dasher.run_principal_revision', true
      ), '') <> ''
      AND state = 'approval_required'
      AND EXISTS (
        SELECT 1
        FROM dasher.run_service_principal_allowlist AS principal
        WHERE principal.run_service_principal_id = NULLIF(current_setting(
            'dasher.run_principal_id', true
          ), '')::uuid
          AND principal.principal_revision = NULLIF(current_setting(
            'dasher.run_principal_revision', true
          ), '')::bigint
          AND principal.session_login = session_user
          AND principal.database_name = pg_catalog.current_database()
          AND principal.enabled
          AND NULLIF(current_setting(
            'dasher.run_capability', true
          ), '') = ANY(principal.capabilities)
          AND NOT EXISTS (
            SELECT 1
            FROM dasher.run_service_principal_allowlist AS later
            WHERE later.run_service_principal_id
              = principal.run_service_principal_id
              AND later.principal_revision > principal.principal_revision
          )
      )
  )
);

ALTER POLICY agent_run_request_payloads_run_definer_select
ON dasher.agent_run_request_payloads
USING (
  (
    EXISTS (
      SELECT 1
      FROM dasher.agent_runs AS policy_run
      WHERE policy_run.organization_id = agent_run_request_payloads.organization_id
        AND policy_run.dashboard_id = agent_run_request_payloads.dashboard_id
        AND policy_run.request_payload_id = agent_run_request_payloads.request_payload_id
        AND (
          dasher_private.run_policy_allows_v1(
            policy_run.organization_id, policy_run.dashboard_id, policy_run.run_id
          ) OR (
            current_user = 'dasher_run_definer'::name
            AND current_setting('dasher.run_phase', true) = 'replay_source_read'
            AND policy_run.organization_id = NULLIF(current_setting(
              'dasher.run_organization_id', true
            ), '')::uuid
            AND policy_run.dashboard_id = NULLIF(current_setting(
              'dasher.run_dashboard_id', true
            ), '')::uuid
            AND policy_run.run_id = NULLIF(current_setting(
              'dasher.run_replay_source_id', true
            ), '')::uuid
          )
        )
    )
  ) OR (
    (
      current_setting('dasher.run_phase', true) = 'replay_discovering'
      AND organization_id = NULLIF(current_setting(
        'dasher.run_organization_id', true
      ), '')::uuid
      AND dashboard_id = NULLIF(current_setting(
        'dasher.run_dashboard_id', true
      ), '')::uuid
      AND request_payload_id = NULLIF(current_setting(
        'dasher.run_request_payload_id', true
      ), '')::uuid
    ) OR (
      current_user = 'dasher_run_definer'::name
      AND current_setting(
        'dasher.run_phase', true
      ) = 'request_replay_locking'
      AND NULLIF(current_setting('dasher.run_capability', true), '')
        = 'replay_source_fence_request'
      AND NULLIF(current_setting('dasher.security_function', true), '')
        = 'request_agent_run'
      AND organization_id = NULLIF(current_setting(
        'dasher.run_organization_id', true
      ), '')::uuid
      AND dashboard_id = NULLIF(current_setting(
        'dasher.run_dashboard_id', true
      ), '')::uuid
      AND EXISTS (
        SELECT 1 FROM dasher.agent_runs AS source_run
        WHERE source_run.organization_id
          = agent_run_request_payloads.organization_id
          AND source_run.dashboard_id
          = agent_run_request_payloads.dashboard_id
          AND source_run.run_id = NULLIF(current_setting(
            'dasher.run_replay_source_id', true
          ), '')::uuid
          AND source_run.request_payload_id
          = agent_run_request_payloads.request_payload_id
      )
    )
  )
);

ALTER POLICY source_snapshots_run_select
ON dasher.source_snapshots
USING (
  (
    current_user = 'dasher_run_definer'::name
      AND current_setting('dasher.run_phase', true) IN ('authorized', 'checkpoint_replay')
      AND NULLIF(current_setting(
        'dasher.run_capability', true
      ), '') = ANY(ARRAY[
        'commit_bundle', 'commit_claims', 'commit_graph', 'read_input'
      ]::text[])
      AND COALESCE(current_setting('dasher.run_principal_id', true), '') <> ''
      AND COALESCE(current_setting(
        'dasher.run_principal_revision', true
      ), '') <> ''
      AND EXISTS (
        SELECT 1
        FROM dasher.run_service_principal_allowlist AS principal
        WHERE principal.run_service_principal_id = NULLIF(current_setting(
            'dasher.run_principal_id', true
          ), '')::uuid
          AND principal.principal_revision = NULLIF(current_setting(
            'dasher.run_principal_revision', true
          ), '')::bigint
          AND principal.session_login = session_user
          AND principal.database_name = pg_catalog.current_database()
          AND principal.enabled
          AND NULLIF(current_setting(
            'dasher.run_capability', true
          ), '') = ANY(principal.capabilities)
          AND NOT EXISTS (
            SELECT 1
            FROM dasher.run_service_principal_allowlist AS later
            WHERE later.run_service_principal_id
              = principal.run_service_principal_id
              AND later.principal_revision > principal.principal_revision
          )
      )
      AND organization_id = NULLIF(current_setting('dasher.run_organization_id', true), '')::uuid
  ) OR (
    ((
      current_setting('dasher.run_phase', true) = 'locking'
      AND current_user = 'dasher_run_definer'::name
      AND NULLIF(current_setting(
        'dasher.run_capability', true
      ), '') = ANY(ARRAY[
        'read_input','clone_replay','read_replay','consume_replay','checkpoint',
        'commit_graph','commit_candidate','close_candidate_set',
        'commit_validation','commit_claims','commit_manifest',
        'commit_abstention','finalize_ranking','finish'
      ]::text[])
    ) OR (
      current_user = 'dasher_run_definer'::name
      AND current_setting(
        'dasher.run_phase', true
      ) = 'request_replay_locking'
      AND NULLIF(current_setting('dasher.run_capability', true), '')
        = 'replay_source_fence_request'
      AND NULLIF(current_setting('dasher.security_function', true), '')
        = 'request_agent_run'
    ))
    AND organization_id = NULLIF(current_setting(
      'dasher.run_organization_id', true
    ), '')::uuid
    AND snapshot_id = NULLIF(current_setting(
      'dasher.run_lock_snapshot_id', true
    ), '')::uuid
  )
);

ALTER POLICY source_snapshots_run_lock_update
ON dasher.source_snapshots
USING (
  (
    current_user = 'dasher_run_definer'::name
      AND current_setting('dasher.run_phase', true) = 'authorized'
      AND NULLIF(current_setting('dasher.run_capability', true), '')
        = ANY(ARRAY[
          'read_input','commit_bundle','commit_graph','reconcile',
          'commit_validation','commit_claims','commit_manifest','finalize_ranking'
        ]::text[])
      AND organization_id = NULLIF(current_setting('dasher.run_organization_id', true), '')::uuid
      AND snapshot_id = NULLIF(current_setting(
        'dasher.run_lock_snapshot_id', true
      ), '')::uuid
  ) OR (
    ((
      current_setting('dasher.run_phase', true) = 'locking'
      AND current_user = 'dasher_run_definer'::name
      AND NULLIF(current_setting(
        'dasher.run_capability', true
      ), '') = ANY(ARRAY[
        'read_input','clone_replay','read_replay','consume_replay','checkpoint',
        'commit_graph','commit_candidate','close_candidate_set',
        'commit_validation','commit_claims','commit_manifest',
        'commit_abstention','finalize_ranking','finish'
      ]::text[])
    ) OR (
      current_user = 'dasher_run_definer'::name
      AND current_setting(
        'dasher.run_phase', true
      ) = 'request_replay_locking'
      AND NULLIF(current_setting('dasher.run_capability', true), '')
        = 'replay_source_fence_request'
      AND NULLIF(current_setting('dasher.security_function', true), '')
        = 'request_agent_run'
    ))
    AND organization_id = NULLIF(current_setting(
      'dasher.run_organization_id', true
    ), '')::uuid
    AND snapshot_id = NULLIF(current_setting(
      'dasher.run_lock_snapshot_id', true
    ), '')::uuid
  )
)
WITH CHECK (false);

ALTER POLICY evidence_records_run_select
ON dasher.evidence_records
USING (
  (
    current_user = 'dasher_run_definer'::name
      AND current_setting('dasher.run_phase', true) IN ('authorized', 'checkpoint_replay')
      AND NULLIF(current_setting('dasher.run_capability', true), '')
        = ANY(ARRAY[
          'read_input','commit_bundle','commit_graph','reconcile',
          'commit_validation','commit_claims','commit_manifest','finalize_ranking'
        ]::text[])
      AND COALESCE(current_setting('dasher.run_principal_id', true), '') <> ''
      AND COALESCE(current_setting(
        'dasher.run_principal_revision', true
      ), '') <> ''
      AND EXISTS (
        SELECT 1
        FROM dasher.run_service_principal_allowlist AS principal
        WHERE principal.run_service_principal_id = NULLIF(current_setting(
            'dasher.run_principal_id', true
          ), '')::uuid
          AND principal.principal_revision = NULLIF(current_setting(
            'dasher.run_principal_revision', true
          ), '')::bigint
          AND principal.session_login = session_user
          AND principal.database_name = pg_catalog.current_database()
          AND principal.enabled
          AND NULLIF(current_setting(
            'dasher.run_capability', true
          ), '') = ANY(principal.capabilities)
          AND NOT EXISTS (
            SELECT 1
            FROM dasher.run_service_principal_allowlist AS later
            WHERE later.run_service_principal_id
              = principal.run_service_principal_id
              AND later.principal_revision > principal.principal_revision
          )
      )
      AND organization_id = NULLIF(current_setting('dasher.run_organization_id', true), '')::uuid
  ) OR (
    ((
      current_setting('dasher.run_phase', true) = 'locking'
      AND current_user = 'dasher_run_definer'::name
      AND NULLIF(current_setting(
        'dasher.run_capability', true
      ), '') = ANY(ARRAY[
        'read_input','clone_replay','read_replay','consume_replay','checkpoint',
        'commit_graph','commit_candidate','close_candidate_set',
        'commit_validation','commit_claims','commit_manifest',
        'commit_abstention','finalize_ranking','finish'
      ]::text[])
    ) OR (
      current_user = 'dasher_run_definer'::name
      AND current_setting(
        'dasher.run_phase', true
      ) = 'request_replay_locking'
      AND NULLIF(current_setting('dasher.run_capability', true), '')
        = 'replay_source_fence_request'
      AND NULLIF(current_setting('dasher.security_function', true), '')
        = 'request_agent_run'
    ))
    AND organization_id = NULLIF(current_setting(
      'dasher.run_organization_id', true
    ), '')::uuid
    AND evidence_id = NULLIF(current_setting(
      'dasher.run_lock_evidence_id', true
    ), '')::uuid
  )
);

ALTER POLICY evidence_records_run_lock_update
ON dasher.evidence_records
USING (
  (
    current_user = 'dasher_run_definer'::name
      AND current_setting('dasher.run_phase', true) = 'authorized'
      AND NULLIF(current_setting('dasher.run_capability', true), '')
        = ANY(ARRAY[
          'read_input','commit_bundle','commit_graph','reconcile',
          'commit_validation','commit_claims','commit_manifest','finalize_ranking'
        ]::text[])
      AND organization_id = NULLIF(current_setting('dasher.run_organization_id', true), '')::uuid
      AND evidence_id = NULLIF(current_setting(
        'dasher.run_lock_evidence_id', true
      ), '')::uuid
  ) OR (
    ((
      current_setting('dasher.run_phase', true) = 'locking'
      AND current_user = 'dasher_run_definer'::name
      AND NULLIF(current_setting(
        'dasher.run_capability', true
      ), '') = ANY(ARRAY[
        'read_input','clone_replay','read_replay','consume_replay','checkpoint',
        'commit_graph','commit_candidate','close_candidate_set',
        'commit_validation','commit_claims','commit_manifest',
        'commit_abstention','finalize_ranking','finish'
      ]::text[])
    ) OR (
      current_user = 'dasher_run_definer'::name
      AND current_setting(
        'dasher.run_phase', true
      ) = 'request_replay_locking'
      AND NULLIF(current_setting('dasher.run_capability', true), '')
        = 'replay_source_fence_request'
      AND NULLIF(current_setting('dasher.security_function', true), '')
        = 'request_agent_run'
    ))
    AND organization_id = NULLIF(current_setting(
      'dasher.run_organization_id', true
    ), '')::uuid
    AND evidence_id = NULLIF(current_setting(
      'dasher.run_lock_evidence_id', true
    ), '')::uuid
  )
)
WITH CHECK (false);

ALTER POLICY candidate_comparison_bundles_run_definer_select
ON dasher.candidate_comparison_bundles
USING (
  (
    dasher_private.run_policy_allows_v1(organization_id, dashboard_id, run_id)
      OR (
        current_user = 'dasher_run_definer'::name
        AND current_setting('dasher.run_phase', true) = 'replay_source_read'
        AND organization_id = NULLIF(current_setting(
          'dasher.run_organization_id', true
        ), '')::uuid
        AND dashboard_id = NULLIF(current_setting('dasher.run_dashboard_id', true), '')::uuid
        AND run_id = NULLIF(current_setting('dasher.run_replay_source_id', true), '')::uuid
      )
  ) OR (
    (
      current_setting('dasher.run_phase', true) = 'locking'
      AND current_user = 'dasher_run_definer'::name
      AND NULLIF(current_setting(
        'dasher.run_capability', true
      ), '') = ANY(ARRAY[
        'read_input','clone_replay','read_replay','consume_replay','checkpoint',
        'commit_graph','commit_candidate','close_candidate_set',
        'commit_validation','commit_claims','commit_manifest',
        'commit_abstention','finalize_ranking','finish'
      ]::text[])
      AND organization_id = NULLIF(current_setting(
        'dasher.run_organization_id', true
      ), '')::uuid
      AND dashboard_id = NULLIF(current_setting(
        'dasher.run_dashboard_id', true
      ), '')::uuid
      AND run_id = NULLIF(current_setting(
        'dasher.run_lock_run_id', true
      ), '')::uuid
    ) OR (
      current_user = 'dasher_run_definer'::name
      AND current_setting(
        'dasher.run_phase', true
      ) = 'request_replay_locking'
      AND NULLIF(current_setting('dasher.run_capability', true), '')
        = 'replay_source_fence_request'
      AND NULLIF(current_setting('dasher.security_function', true), '')
        = 'request_agent_run'
      AND organization_id = NULLIF(current_setting(
        'dasher.run_organization_id', true
      ), '')::uuid
      AND dashboard_id = NULLIF(current_setting(
        'dasher.run_dashboard_id', true
      ), '')::uuid
      AND run_id = NULLIF(current_setting(
        'dasher.run_replay_source_id', true
      ), '')::uuid
    )
  )
);

ALTER POLICY candidate_comparison_bundles_run_lock_update
ON dasher.candidate_comparison_bundles
USING (
  (
    current_user = 'dasher_run_definer'::name
      AND (
        current_setting('dasher.run_phase', true) = 'locking'
        OR (
          current_setting('dasher.run_phase', true) = 'authorized'
          AND NULLIF(current_setting('dasher.run_capability', true), '')
            = 'commit_brief'
        )
      )
      AND organization_id = NULLIF(current_setting(
        'dasher.run_organization_id', true
      ), '')::uuid
      AND dashboard_id = NULLIF(current_setting(
        'dasher.run_dashboard_id', true
      ), '')::uuid
      AND run_id = NULLIF(current_setting('dasher.run_id', true), '')::uuid
  ) OR (
    (
      current_setting('dasher.run_phase', true) = 'authorized'
      AND NULLIF(current_setting('dasher.run_capability', true), '')
        = ANY(ARRAY[
          'reserve','reconcile','commit_graph','commit_candidate',
          'commit_validation','close_candidate_set','commit_claims',
          'commit_manifest','finalize_ranking'
        ]::text[])
      AND run_id = NULLIF(current_setting('dasher.run_id', true), '')::uuid
    ) OR (
      current_setting('dasher.run_phase', true) = 'locking'
      AND current_user = 'dasher_run_definer'::name
      AND NULLIF(current_setting(
        'dasher.run_capability', true
      ), '') = ANY(ARRAY[
        'read_input','clone_replay','read_replay','consume_replay','checkpoint',
        'commit_graph','commit_candidate','close_candidate_set',
        'commit_validation','commit_claims','commit_manifest',
        'commit_abstention','finalize_ranking','finish'
      ]::text[])
      AND run_id = NULLIF(current_setting(
        'dasher.run_lock_run_id', true
      ), '')::uuid
    ) OR (
      current_user = 'dasher_run_definer'::name
      AND current_setting(
        'dasher.run_phase', true
      ) = 'request_replay_locking'
      AND NULLIF(current_setting('dasher.run_capability', true), '')
        = 'replay_source_fence_request'
      AND NULLIF(current_setting('dasher.security_function', true), '')
        = 'request_agent_run'
      AND run_id = NULLIF(current_setting(
        'dasher.run_replay_source_id', true
      ), '')::uuid
    )
  )
);

CREATE OR REPLACE FUNCTION dasher_private.reauthorize_agent_run_v1(
  p_run_id uuid,
  p_lease_epoch bigint,
  p_attempt_token bytea
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_run dasher.agent_runs%ROWTYPE;
  v_membership record;
  v_principal dasher.run_service_principal_allowlist%ROWTYPE;
  v_principal_revision dasher.run_service_principal_allowlist%ROWTYPE;
  v_lifecycle_policy record;
  v_policy dasher.agent_run_policy_revisions%ROWTYPE;
  v_dashboard record;
  v_expected_principal_revision bigint := 0;
  v_principal_id uuid;
  v_previous_principal_sha bytea;
  v_capability text;
  v_previous_capability text;
  v_capability_bytes bytea;
  v_capabilities_sha bytea;
  v_principal_sha bytea;
  v_now timestamptz := pg_catalog.statement_timestamp();
  v_terminal_reconcile_replay boolean := false;
  v_discovery_payload dasher.agent_run_request_payloads%ROWTYPE;
  v_discovery_request jsonb;
  v_source_discovery dasher.agent_runs%ROWTYPE;
  v_locked_run dasher.agent_runs%ROWTYPE;
  v_lock_membership record;
  v_locked_membership record;
  v_source_membership record;
  v_lock_run_id uuid;
  v_local_request_payload_id uuid;
  v_source_request_payload_id uuid;
  v_discovery_semantic_sha bytea;
  v_discovery_envelope_sha bytea;
BEGIN
  IF current_user <> 'dasher_run_definer'::name
    OR p_run_id IS NULL OR p_lease_epoch < 1
    OR p_attempt_token IS NULL OR pg_catalog.octet_length(p_attempt_token) <> 32
    OR current_setting('dasher.run_principal_id', true) IS NULL
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;

  PERFORM pg_catalog.set_config('dasher.run_id', p_run_id::text, true);
  PERFORM pg_catalog.set_config('dasher.run_phase', 'discovering', true);
  SELECT run.* INTO v_run
  FROM dasher.agent_runs AS run
  WHERE run.run_id = p_run_id;
  IF NOT FOUND OR v_run.request_payload_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  v_local_request_payload_id := v_run.request_payload_id;
  PERFORM pg_catalog.set_config(
    'dasher.run_request_payload_id', v_run.request_payload_id::text, true
  );
  PERFORM pg_catalog.set_config(
    'dasher.run_organization_id', v_run.organization_id::text, true
  );
  PERFORM pg_catalog.set_config(
    'dasher.run_dashboard_id', v_run.dashboard_id::text, true
  );
  PERFORM pg_catalog.set_config('dasher.run_phase', 'replay_discovering', true);
  SELECT payload.* INTO v_discovery_payload
  FROM dasher.agent_run_request_payloads AS payload
  WHERE payload.organization_id = v_run.organization_id
    AND payload.dashboard_id = v_run.dashboard_id
    AND payload.request_payload_id = v_run.request_payload_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  BEGIN
    v_discovery_request := pg_catalog.convert_from(
      v_discovery_payload.canonical_bytes, 'UTF8'
    )::jsonb;
  EXCEPTION WHEN character_not_in_repertoire OR invalid_text_representation
      OR numeric_value_out_of_range THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END;
  v_discovery_semantic_sha := pg_catalog.sha256(
    pg_catalog.convert_to('dasher.agent-run-request.v1', 'UTF8')
    || pg_catalog.decode('00', 'hex')
    || pg_catalog.int4send(pg_catalog.octet_length(
      v_discovery_payload.canonical_bytes
    ))
    || v_discovery_payload.canonical_bytes
  );
  v_discovery_envelope_sha := pg_catalog.sha256(
    pg_catalog.convert_to('dasher.retained-payload-envelope.v1', 'UTF8')
    || pg_catalog.decode('00', 'hex')
    || pg_catalog.int4send(pg_catalog.octet_length('agent-run-request-v1'))
    || pg_catalog.convert_to('agent-run-request-v1', 'UTF8')
    || pg_catalog.int4send(pg_catalog.octet_length(
      v_discovery_payload.content_nonce
    ))
    || v_discovery_payload.content_nonce
    || pg_catalog.int4send(pg_catalog.octet_length(
      v_discovery_semantic_sha
    ))
    || v_discovery_semantic_sha
  );
  IF dasher_private.canonical_jsonb_bytes_v1(v_discovery_request)
      IS DISTINCT FROM v_discovery_payload.canonical_bytes
    OR v_discovery_payload.request_sha256 <> v_discovery_envelope_sha
    OR v_discovery_request->>'purpose' NOT IN ('suggest', 'replay')
    OR (v_discovery_request->>'purpose' = 'suggest') <>
      ((v_discovery_request->>'replay_source_run_id') IS NULL)
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  IF v_discovery_request->>'purpose' = 'replay' THEN
    BEGIN
      PERFORM pg_catalog.set_config(
        'dasher.run_replay_source_id',
        (v_discovery_request->>'replay_source_run_id')::uuid::text, true
      );
      PERFORM pg_catalog.set_config(
        'dasher.run_lock_snapshot_id',
        (v_discovery_request->>'input_snapshot_id')::uuid::text, true
      );
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
    END;
    SELECT source.* INTO v_source_discovery
    FROM dasher.agent_runs AS source
    WHERE source.run_id = NULLIF(current_setting(
      'dasher.run_replay_source_id', true
    ), '')::uuid;
    IF NOT FOUND OR v_source_discovery.organization_id <> v_run.organization_id
      OR v_source_discovery.dashboard_id <> v_run.dashboard_id
    THEN
      RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
    END IF;
    v_source_request_payload_id := v_source_discovery.request_payload_id;
  ELSE
    PERFORM pg_catalog.set_config('dasher.run_replay_source_id', '', true);
  END IF;

  PERFORM pg_catalog.set_config(
    'dasher.run_organization_id', v_run.organization_id::text, true
  );
  PERFORM pg_catalog.set_config(
    'dasher.run_dashboard_id', v_run.dashboard_id::text, true
  );
  PERFORM pg_catalog.set_config(
    'dasher.run_membership_id', v_run.requesting_membership_id::text, true
  );
  PERFORM pg_catalog.set_config(
    'dasher.run_user_id', v_run.requesting_user_id::text, true
  );
  PERFORM pg_catalog.set_config(
    'dasher.run_authority_revision',
    v_run.requesting_authority_revision::text,
    true
  );
  PERFORM pg_catalog.set_config(
    'dasher.run_policy_revision', v_run.policy_revision::text, true
  );
  PERFORM pg_catalog.set_config('dasher.run_phase', 'locking', true);

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'dasher:organization:v1|' || v_run.organization_id::text,
      0
    )
  );
  FOR v_lock_membership IN
    SELECT candidate.membership_id, candidate.user_id,
      candidate.authority_revision
    FROM (VALUES
      (v_run.requesting_membership_id, v_run.requesting_user_id,
        v_run.requesting_authority_revision),
      (v_source_discovery.requesting_membership_id,
        v_source_discovery.requesting_user_id,
        v_source_discovery.requesting_authority_revision)
    ) AS candidate(membership_id, user_id, authority_revision)
    WHERE candidate.membership_id IS NOT NULL
    GROUP BY candidate.membership_id, candidate.user_id,
      candidate.authority_revision
    ORDER BY pg_catalog.uuid_send(candidate.membership_id)
  LOOP
    PERFORM pg_catalog.set_config(
      'dasher.run_lock_membership_id',
      v_lock_membership.membership_id::text, true
    );
    PERFORM pg_catalog.set_config(
      'dasher.run_lock_user_id', v_lock_membership.user_id::text, true
    );
    PERFORM pg_catalog.set_config(
      'dasher.run_lock_authority_revision',
      v_lock_membership.authority_revision::text, true
    );
    SELECT membership.user_id, membership.authority_revision,
        membership.state, membership.role, membership.revoked_at
      INTO v_locked_membership
    FROM dasher.memberships AS membership
    WHERE membership.organization_id = v_run.organization_id
      AND membership.membership_id = v_lock_membership.membership_id
      AND membership.user_id = v_lock_membership.user_id
      AND membership.authority_revision
        = v_lock_membership.authority_revision
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
    END IF;
    IF v_lock_membership.membership_id = v_run.requesting_membership_id THEN
      v_membership := v_locked_membership;
    END IF;
    IF v_lock_membership.membership_id
        = v_source_discovery.requesting_membership_id THEN
      v_source_membership := v_locked_membership;
    END IF;
  END LOOP;
  PERFORM pg_catalog.set_config('dasher.run_lock_membership_id', '', true);
  PERFORM pg_catalog.set_config('dasher.run_lock_user_id', '', true);
  PERFORM pg_catalog.set_config(
    'dasher.run_lock_authority_revision', '', true
  );
  SELECT principal.* INTO v_principal
  FROM dasher.run_service_principal_allowlist AS principal
  WHERE (
      principal.run_service_principal_id = v_run.lease_owner_principal_id
      AND principal.principal_revision = v_run.lease_owner_principal_revision
    ) OR (
      current_setting('dasher.run_capability', true) = 'reconcile'
      AND v_run.state = 'failed'
      AND v_run.lease_epoch = p_lease_epoch + 1
      AND v_run.lease_token_sha256 IS NULL
      AND v_run.lease_owner_principal_id IS NULL
      AND v_run.lease_owner_principal_revision IS NULL
      AND v_run.lease_expires_at IS NULL
      AND principal.run_service_principal_id = current_setting(
        'dasher.run_principal_id', true
      )::uuid
      AND principal.principal_revision = current_setting(
        'dasher.run_principal_revision', true
      )::bigint
    )
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;

  SELECT lifecycle_policy.policy_revision,
      lifecycle_policy.retention_policy_revision
    INTO v_lifecycle_policy
  FROM dasher.dashboard_lifecycle_policies AS lifecycle_policy
  WHERE lifecycle_policy.organization_id = v_run.organization_id
  ORDER BY lifecycle_policy.policy_revision DESC
  LIMIT 1
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  PERFORM pg_catalog.set_config(
    'dasher.run_lifecycle_policy_revision',
    v_lifecycle_policy.policy_revision::text, true
  );
  SELECT policy.* INTO v_policy
  FROM dasher.agent_run_policy_revisions AS policy
  WHERE policy.policy_revision = v_run.policy_revision
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  SELECT dashboard.current_kind, dashboard.lifecycle_state,
      dashboard.effective_expires_at, dashboard.access_revoked_at,
      dashboard.purged_at
    INTO v_dashboard
  FROM dasher.dashboards AS dashboard
  WHERE dashboard.organization_id = v_run.organization_id
    AND dashboard.dashboard_id = v_run.dashboard_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  FOR v_lock_run_id IN
    SELECT candidate.run_id
    FROM (VALUES
      (p_run_id), (v_source_discovery.run_id)
    ) AS candidate(run_id)
    WHERE candidate.run_id IS NOT NULL
    GROUP BY candidate.run_id
    ORDER BY pg_catalog.uuid_send(candidate.run_id)
  LOOP
    PERFORM pg_catalog.set_config(
      'dasher.run_lock_run_id', v_lock_run_id::text, true
    );
    SELECT locked_run.* INTO v_locked_run
    FROM dasher.agent_runs AS locked_run
    WHERE locked_run.organization_id = v_run.organization_id
      AND locked_run.dashboard_id = v_run.dashboard_id
      AND locked_run.run_id = v_lock_run_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
    END IF;
    IF v_lock_run_id = p_run_id THEN
      v_run := v_locked_run;
    END IF;
    IF v_lock_run_id = v_source_discovery.run_id THEN
      v_source_discovery := v_locked_run;
    END IF;
  END LOOP;
  PERFORM pg_catalog.set_config('dasher.run_lock_run_id', '', true);
  IF v_run.request_payload_id IS DISTINCT FROM v_local_request_payload_id THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  IF v_source_request_payload_id IS NOT NULL THEN
    IF v_source_discovery.request_payload_id
          IS DISTINCT FROM v_source_request_payload_id
      OR v_source_discovery.organization_id <> v_run.organization_id
      OR v_source_discovery.dashboard_id <> v_run.dashboard_id
      OR v_source_discovery.state <> 'approval_required'
      OR v_source_discovery.lease_token_sha256 IS NOT NULL
      OR v_source_discovery.lease_owner_principal_id IS NOT NULL
      OR v_source_discovery.lease_owner_principal_revision IS NOT NULL
      OR v_source_discovery.lease_expires_at IS NOT NULL
      OR v_source_membership.user_id
        <> v_source_discovery.requesting_user_id
      OR v_source_membership.authority_revision
        <> v_source_discovery.requesting_authority_revision
      OR v_source_membership.state <> 'active'
      OR v_source_membership.role NOT IN ('editor', 'admin')
      OR v_source_membership.revoked_at IS NOT NULL
    THEN
      RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
    END IF;
  END IF;

  v_terminal_reconcile_replay :=
    current_setting('dasher.run_capability', true) = 'reconcile'
    AND v_run.state = 'failed'
    AND v_run.lease_epoch = p_lease_epoch + 1
    AND v_run.lease_token_sha256 IS NULL
    AND v_run.lease_owner_principal_id IS NULL
    AND v_run.lease_owner_principal_revision IS NULL
    AND v_run.lease_expires_at IS NULL
    AND EXISTS (
      SELECT 1
      FROM dasher.agent_run_events AS claim_event
      WHERE claim_event.organization_id = v_run.organization_id
        AND claim_event.dashboard_id = v_run.dashboard_id
        AND claim_event.run_id = v_run.run_id
        AND claim_event.event_kind = 'lease_acquired'
        AND claim_event.claim_operation_kind = 'ordinary_claim'
        AND claim_event.claim_result_state = 'running'
        AND claim_event.claim_result_lease_epoch = p_lease_epoch
        AND claim_event.claim_result_attempt_token = p_attempt_token
        AND claim_event.claim_result_lease_expires_at IS NOT NULL
        AND extract(epoch FROM (
          claim_event.claim_result_lease_expires_at
            - claim_event.occurred_at
        ))::bigint BETWEEN 1 AND 900
        AND claim_event.claim_result_policy_revision = v_run.policy_revision
        AND claim_event.claim_result_input_sha256 =
          claim_event.claim_input_sha256
        AND claim_event.claim_input_sha256 = pg_catalog.sha256(
          pg_catalog.convert_to(
            'dasher.agent-run-ordinary-claim-input.v1', 'UTF8'
          )
          || pg_catalog.decode('00', 'hex')
          || pg_catalog.uuid_send(claim_event.claim_request_id)
          || pg_catalog.int8send(extract(epoch FROM (
            claim_event.claim_result_lease_expires_at
              - claim_event.occurred_at
          ))::bigint)
          || pg_catalog.uuid_send(v_principal.run_service_principal_id)
          || pg_catalog.int8send(v_principal.principal_revision)
          || v_principal.principal_sha256
        )
        AND claim_event.claim_result_sha256 = pg_catalog.sha256(
          pg_catalog.convert_to('dasher.agent-run-claim-result.v1', 'UTF8')
          || pg_catalog.decode('00', 'hex')
          || pg_catalog.int4send(pg_catalog.octet_length(
            claim_event.claim_operation_kind
          ))
          || pg_catalog.convert_to(
            claim_event.claim_operation_kind, 'UTF8'
          )
          || pg_catalog.uuid_send(claim_event.claim_request_id)
          || claim_event.claim_input_sha256
          || pg_catalog.int4send(pg_catalog.octet_length('claimed'))
          || pg_catalog.convert_to('claimed', 'UTF8')
          || pg_catalog.uuid_send(claim_event.organization_id)
          || pg_catalog.uuid_send(claim_event.dashboard_id)
          || pg_catalog.uuid_send(claim_event.run_id)
          || pg_catalog.int8send(claim_event.claim_result_run_revision)
          || pg_catalog.int4send(pg_catalog.octet_length(
            claim_event.claim_result_state
          ))
          || pg_catalog.convert_to(claim_event.claim_result_state, 'UTF8')
          || pg_catalog.int8send(claim_event.claim_result_lease_epoch)
          || pg_catalog.decode('01', 'hex')
          || pg_catalog.int4send(pg_catalog.octet_length(
            claim_event.claim_result_attempt_token
          ))
          || claim_event.claim_result_attempt_token
          || pg_catalog.decode('01', 'hex')
          || pg_catalog.int8send((extract(epoch FROM
            claim_event.claim_result_lease_expires_at
          ) * 1000000)::bigint)
          || pg_catalog.int8send(
            claim_event.claim_result_policy_revision
          )
          || pg_catalog.decode('01', 'hex')
          || pg_catalog.int4send(pg_catalog.octet_length(
            claim_event.claim_result_input_sha256
          ))
          || claim_event.claim_result_input_sha256
        )
    );

  FOR v_principal_revision IN
    SELECT principal.*
    FROM dasher.run_service_principal_allowlist AS principal
    WHERE principal.run_service_principal_id = v_principal.run_service_principal_id
      AND principal.session_login = session_user
      AND principal.database_oid = (
        SELECT database_row.oid
        FROM pg_catalog.pg_database AS database_row
        WHERE database_row.datname = pg_catalog.current_database()
      )
      AND principal.database_name = pg_catalog.current_database()
    ORDER BY principal.principal_revision
  LOOP
    IF v_principal_id IS NULL THEN
      v_principal_id := v_principal_revision.run_service_principal_id;
    END IF;
    v_expected_principal_revision := v_expected_principal_revision + 1;
    v_capability_bytes := ''::bytea;
    v_previous_capability := NULL;
    FOREACH v_capability IN ARRAY v_principal_revision.capabilities LOOP
      IF v_capability IS NULL
        OR (v_previous_capability IS NOT NULL AND pg_catalog.convert_to(
          v_capability, 'UTF8'
        ) <= pg_catalog.convert_to(v_previous_capability, 'UTF8'))
      THEN
        RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
      END IF;
      v_capability_bytes := v_capability_bytes
        || pg_catalog.int4send(pg_catalog.octet_length(v_capability))
        || pg_catalog.convert_to(v_capability, 'UTF8');
      v_previous_capability := v_capability;
    END LOOP;
    v_capabilities_sha := pg_catalog.sha256(
      pg_catalog.convert_to('dasher.run-principal-capabilities.v1', 'UTF8')
      || pg_catalog.decode('00', 'hex')
      || pg_catalog.int8send(pg_catalog.cardinality(
        v_principal_revision.capabilities
      ))
      || v_capability_bytes
    );
    v_principal_sha := pg_catalog.sha256(
      pg_catalog.convert_to('dasher.run-principal.v1', 'UTF8')
      || pg_catalog.decode('00', 'hex')
      || pg_catalog.uuid_send(v_principal_revision.run_service_principal_id)
      || pg_catalog.int8send(v_principal_revision.principal_revision)
      || CASE WHEN v_principal_revision.previous_principal_revision IS NULL
        THEN pg_catalog.decode('00', 'hex')
        ELSE pg_catalog.decode('01', 'hex')
          || pg_catalog.int8send(
            v_principal_revision.previous_principal_revision
          ) END
      || CASE WHEN v_principal_revision.previous_principal_sha256 IS NULL
        THEN pg_catalog.decode('00', 'hex')
        ELSE pg_catalog.decode('01', 'hex')
          || pg_catalog.int4send(pg_catalog.octet_length(
            v_principal_revision.previous_principal_sha256
          ))
          || v_principal_revision.previous_principal_sha256 END
      || pg_catalog.int4send(pg_catalog.octet_length(
        v_principal_revision.session_login::text
      ))
      || pg_catalog.convert_to(v_principal_revision.session_login::text, 'UTF8')
      || CASE WHEN v_principal_revision.enabled
        THEN pg_catalog.decode('01', 'hex')
        ELSE pg_catalog.decode('00', 'hex') END
      || pg_catalog.int8send(pg_catalog.cardinality(
        v_principal_revision.capabilities
      ))
      || v_capability_bytes
      || pg_catalog.int4send(pg_catalog.octet_length(v_capabilities_sha))
      || v_capabilities_sha
      || pg_catalog.int8send(v_principal_revision.database_oid::bigint)
      || pg_catalog.int4send(pg_catalog.octet_length(
        v_principal_revision.database_name::text
      ))
      || pg_catalog.convert_to(
        v_principal_revision.database_name::text, 'UTF8'
      )
    );
    IF v_principal_revision.principal_revision <>
        v_expected_principal_revision
      OR (v_expected_principal_revision = 1 AND ROW(
        v_principal_revision.previous_principal_revision,
        v_principal_revision.previous_principal_sha256
      ) IS DISTINCT FROM ROW(NULL::bigint, NULL::bytea))
      OR (v_expected_principal_revision > 1 AND ROW(
        v_principal_revision.previous_principal_revision,
        v_principal_revision.previous_principal_sha256
      ) IS DISTINCT FROM ROW(
        v_expected_principal_revision - 1, v_previous_principal_sha
      ))
      OR v_principal_revision.capabilities_sha256 <> v_capabilities_sha
      OR v_principal_revision.principal_sha256 <> v_principal_sha
    THEN
      RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
    END IF;
    v_previous_principal_sha := v_principal_revision.principal_sha256;
  END LOOP;

  IF v_membership.user_id <> v_run.requesting_user_id
    OR v_membership.authority_revision <> v_run.requesting_authority_revision
    OR v_membership.state <> 'active'
    OR v_membership.role NOT IN ('editor', 'admin')
    OR v_membership.revoked_at IS NOT NULL
    OR v_expected_principal_revision <> v_principal.principal_revision
    OR v_principal IS DISTINCT FROM v_principal_revision
    OR NOT v_principal.enabled
    OR current_setting('dasher.run_principal_id', true)::uuid <>
      v_principal.run_service_principal_id
    OR current_setting('dasher.run_principal_revision', true)::bigint <>
      v_principal.principal_revision
    OR NOT current_setting('dasher.run_capability', true) =
      ANY(v_principal.capabilities)
    OR pg_catalog.encode(v_principal.principal_sha256, 'hex') <>
      current_setting('dasher.run_principal_sha256', true)
    OR v_policy.policy_revision <> v_run.policy_revision
    OR NOT v_policy.enabled
    OR NOT dasher_private.validate_agent_run_policy_chain_v1()
    OR EXISTS (
      SELECT 1 FROM dasher.agent_run_policy_revisions AS later
      WHERE later.policy_revision > v_policy.policy_revision
    )
    OR v_lifecycle_policy.policy_revision < 1
    OR v_lifecycle_policy.retention_policy_revision < 1
    OR v_dashboard.lifecycle_state NOT IN ('draft', 'active')
    OR v_dashboard.access_revoked_at IS NOT NULL
    OR v_dashboard.purged_at IS NOT NULL
    OR (v_dashboard.current_kind = 'disposable'
      AND v_dashboard.effective_expires_at IS NOT NULL
      AND v_now >= v_dashboard.effective_expires_at)
    OR NOT (
      v_terminal_reconcile_replay
      OR (
        v_run.state IN (
          'requested', 'authorized', 'planning', 'generating',
          'revising', 'validating'
        )
        AND v_run.lease_epoch = p_lease_epoch
        AND v_run.lease_owner_principal_id = current_setting(
          'dasher.run_principal_id', true
        )::uuid
        AND v_run.lease_owner_principal_revision = current_setting(
          'dasher.run_principal_revision', true
        )::bigint
        AND v_run.lease_expires_at > v_now
        AND v_run.lease_token_sha256 = pg_catalog.sha256(
          pg_catalog.convert_to('dasher.agent-run-lease-token.v1', 'UTF8')
          || pg_catalog.decode('00', 'hex')
          || pg_catalog.uuid_send(p_run_id)
          || pg_catalog.int8send(p_lease_epoch)
          || pg_catalog.uuid_send(current_setting(
            'dasher.run_principal_id', true
          )::uuid)
          || pg_catalog.int8send(current_setting(
            'dasher.run_principal_revision', true
          )::bigint)
          || pg_catalog.int4send(pg_catalog.octet_length(p_attempt_token))
          || p_attempt_token
        )
      )
    )
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  PERFORM pg_catalog.set_config(
    'dasher.run_phase', CASE
      WHEN v_source_request_payload_id IS NULL THEN 'authorized'
      ELSE 'locking' END, true
  );
END
$function$;

CREATE OR REPLACE FUNCTION dasher_private.replay_source_fence_v1(
  p_organization_id uuid,
  p_source_run_id uuid
)
RETURNS dasher.agent_runs
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_source dasher.agent_runs%ROWTYPE;
  v_source_discovery dasher.agent_runs%ROWTYPE;
  v_request dasher.agent_run_request_payloads%ROWTYPE;
  v_request_body jsonb;
  v_local_request dasher.agent_run_request_payloads%ROWTYPE;
  v_local_request_body jsonb;
  v_result dasher.agent_recorded_results%ROWTYPE;
  v_result_payload dasher.agent_run_attempt_payloads%ROWTYPE;
  v_source_snapshot dasher.source_snapshots%ROWTYPE;
  v_local_snapshot dasher.source_snapshots%ROWTYPE;
  v_locked_snapshot dasher.source_snapshots%ROWTYPE;
  v_source_bundle dasher.candidate_comparison_bundles%ROWTYPE;
  v_locked_bundle dasher.candidate_comparison_bundles%ROWTYPE;
  v_local_bundle dasher.candidate_comparison_bundles%ROWTYPE;
  v_source_brief dasher.briefs%ROWTYPE;
  v_locked_evidence dasher.evidence_records%ROWTYPE;
  v_member record;
  v_lock_snapshot_id uuid;
  v_lock_run_id uuid;
  v_local_input_snapshot_id uuid;
  v_source_input_snapshot_id uuid;
  v_source_members jsonb;
  v_revalidated_members jsonb;
  v_local_members jsonb;
  v_local_brief dasher.briefs%ROWTYPE;
  v_local_catalog dasher.field_catalog_snapshots%ROWTYPE;
  v_local_contract_count bigint;
  v_request_mode boolean := COALESCE(
    NULLIF(current_setting('dasher.security_function', true), '') =
      'request_agent_run',
    false
  );
  v_semantic_sha bytea;
  v_envelope_sha bytea;
  v_expected_head bytea;
  v_prior_head bytea;
  v_expected_sequence bigint := 0;
  v_lock_membership record;
  v_locked_membership record;
  v_current_membership record;
  v_source_membership record;
  v_revalidated_source_membership record;
  v_lifecycle_policy record;
  v_policy dasher.agent_run_policy_revisions%ROWTYPE;
  v_dashboard record;
  v_local_request_semantic_sha bytea;
  v_result_spec_bytes bytea;
  v_result_precommit_bytes bytea;
  v_source_candidate_results jsonb := '{}'::jsonb;
  v_selected_candidate_proof jsonb;
  v_candidate_receipt_sha bytea;
BEGIN
  IF p_organization_id IS NULL OR p_source_run_id IS NULL
    OR current_setting('dasher.run_organization_id', true)
      IS DISTINCT FROM p_organization_id::text
    OR COALESCE(current_setting('dasher.run_dashboard_id', true), '') = ''
    OR NULLIF(current_setting('dasher.run_lock_snapshot_id', true), '') IS NULL
    OR (
      v_request_mode
      AND (
        NULLIF(current_setting('dasher.run_capability', true), '')
          <> 'replay_source_fence_request'
        OR current_setting('dasher.run_phase', true)
          <> 'request_replay_locking'
      )
    )
    OR (
      NOT v_request_mode
      AND (
        NOT (COALESCE(NULLIF(current_setting(
          'dasher.run_capability', true
        ), ''), '') = ANY(ARRAY[
            'read_input','clone_replay','read_replay','consume_replay',
            'checkpoint','commit_graph','commit_candidate',
            'close_candidate_set','commit_validation','commit_claims',
            'commit_manifest','commit_abstention','finalize_ranking','finish'
          ]::text[]))
        OR current_setting('dasher.run_phase', true) <> 'locking'
      )
    )
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  IF NOT v_request_mode THEN
    PERFORM pg_catalog.set_config(
      'dasher.run_phase', 'replay_discovering', true
    );
    SELECT payload.* INTO v_local_request
    FROM dasher.agent_run_request_payloads AS payload
    WHERE payload.organization_id = p_organization_id
      AND payload.dashboard_id = NULLIF(current_setting(
        'dasher.run_dashboard_id', true
      ), '')::uuid
      AND payload.request_payload_id = NULLIF(current_setting(
        'dasher.run_request_payload_id', true
      ), '')::uuid;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
    END IF;
    BEGIN
      v_local_request_body := pg_catalog.convert_from(
        v_local_request.canonical_bytes, 'UTF8'
      )::jsonb;
    EXCEPTION WHEN character_not_in_repertoire OR invalid_text_representation
        OR numeric_value_out_of_range THEN
      RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
    END;
    v_semantic_sha := pg_catalog.sha256(
      pg_catalog.convert_to('dasher.agent-run-request.v1', 'UTF8')
      || pg_catalog.decode('00', 'hex')
      || pg_catalog.int4send(pg_catalog.octet_length(
        v_local_request.canonical_bytes
      )) || v_local_request.canonical_bytes
    );
    v_envelope_sha := pg_catalog.sha256(
      pg_catalog.convert_to('dasher.retained-payload-envelope.v1', 'UTF8')
      || pg_catalog.decode('00', 'hex')
      || pg_catalog.int4send(pg_catalog.octet_length('agent-run-request-v1'))
      || pg_catalog.convert_to('agent-run-request-v1', 'UTF8')
      || pg_catalog.int4send(pg_catalog.octet_length(
        v_local_request.content_nonce
      )) || v_local_request.content_nonce
      || pg_catalog.int4send(pg_catalog.octet_length(v_semantic_sha))
      || v_semantic_sha
    );
    IF dasher_private.canonical_jsonb_bytes_v1(v_local_request_body)
        IS DISTINCT FROM v_local_request.canonical_bytes
      OR v_local_request.request_sha256 <> v_envelope_sha
      OR v_local_request_body->>'purpose' <> 'replay'
      OR v_local_request_body->>'replay_source_run_id' <>
        p_source_run_id::text
    THEN
      RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
    END IF;
    v_local_request_semantic_sha := v_semantic_sha;
    PERFORM pg_catalog.set_config('dasher.run_phase', 'locking', true);
  END IF;
  PERFORM pg_catalog.set_config(
    'dasher.run_replay_source_id', p_source_run_id::text, true
  );
  IF v_request_mode THEN
    -- Discover only the exact source pointer needed to derive its requester;
    -- authority remains the tenant function's exact source-ID binding.
    SELECT source.* INTO v_source_discovery
    FROM dasher.agent_runs AS source
    WHERE source.organization_id = p_organization_id
      AND source.dashboard_id = NULLIF(current_setting(
        'dasher.run_dashboard_id', true
      ), '')::uuid
      AND source.run_id = p_source_run_id
      AND source.state = 'approval_required'
      AND source.request_payload_id IS NOT NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
    END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'dasher:organization:v1|' || p_organization_id::text, 0
      )
    );
    BEGIN
      FOR v_lock_membership IN
        SELECT candidate.membership_id, candidate.user_id,
          candidate.authority_revision
        FROM (VALUES
          (NULLIF(current_setting(
              'dasher.run_membership_id', true
            ), '')::uuid,
           NULLIF(current_setting('dasher.run_user_id', true), '')::uuid,
           NULLIF(current_setting(
              'dasher.run_authority_revision', true
            ), '')::bigint),
          (v_source_discovery.requesting_membership_id,
           v_source_discovery.requesting_user_id,
           v_source_discovery.requesting_authority_revision)
        ) AS candidate(membership_id, user_id, authority_revision)
        GROUP BY candidate.membership_id, candidate.user_id,
          candidate.authority_revision
        ORDER BY pg_catalog.uuid_send(candidate.membership_id)
      LOOP
        PERFORM pg_catalog.set_config(
          'dasher.run_lock_membership_id',
          v_lock_membership.membership_id::text, true
        );
        PERFORM pg_catalog.set_config(
          'dasher.run_lock_user_id', v_lock_membership.user_id::text, true
        );
        PERFORM pg_catalog.set_config(
          'dasher.run_lock_authority_revision',
          v_lock_membership.authority_revision::text, true
        );
        SELECT membership.user_id, membership.authority_revision,
            membership.state, membership.role, membership.revoked_at
          INTO v_locked_membership
        FROM dasher.memberships AS membership
        WHERE membership.organization_id = p_organization_id
          AND membership.membership_id = v_lock_membership.membership_id
          AND membership.user_id = v_lock_membership.user_id
          AND membership.authority_revision =
            v_lock_membership.authority_revision
        FOR UPDATE;
        IF NOT FOUND THEN
          RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
        END IF;
        IF v_lock_membership.membership_id = NULLIF(current_setting(
            'dasher.run_membership_id', true
          ), '')::uuid THEN
          v_current_membership := v_locked_membership;
        END IF;
        IF v_lock_membership.membership_id =
            v_source_discovery.requesting_membership_id THEN
          v_source_membership := v_locked_membership;
        END IF;
      END LOOP;
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
    END;
    PERFORM pg_catalog.set_config('dasher.run_lock_membership_id', '', true);
    PERFORM pg_catalog.set_config('dasher.run_lock_user_id', '', true);
    PERFORM pg_catalog.set_config(
      'dasher.run_lock_authority_revision', '', true
    );
    IF v_current_membership.state <> 'active'
      OR v_current_membership.role NOT IN ('editor', 'admin')
      OR v_current_membership.revoked_at IS NOT NULL
      OR v_source_membership.user_id <>
        v_source_discovery.requesting_user_id
      OR v_source_membership.authority_revision <>
        v_source_discovery.requesting_authority_revision
      OR v_source_membership.state <> 'active'
      OR v_source_membership.role NOT IN ('editor', 'admin')
      OR v_source_membership.revoked_at IS NOT NULL
    THEN
      RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
    END IF;
    SELECT lifecycle_policy.policy_revision,
        lifecycle_policy.retention_policy_revision
      INTO v_lifecycle_policy
    FROM dasher.dashboard_lifecycle_policies AS lifecycle_policy
    WHERE lifecycle_policy.organization_id = p_organization_id
      AND lifecycle_policy.policy_revision = NULLIF(current_setting(
        'dasher.run_lifecycle_policy_revision', true
      ), '')::bigint
      AND lifecycle_policy.policy_revision >= 1
      AND lifecycle_policy.retention_policy_revision >= 1
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
    END IF;
    SELECT policy.* INTO v_policy
    FROM dasher.agent_run_policy_revisions AS policy
    WHERE policy.policy_revision = NULLIF(current_setting(
      'dasher.run_policy_revision', true
    ), '')::bigint
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
    END IF;
    SELECT dashboard.current_kind, dashboard.lifecycle_state,
        dashboard.effective_expires_at, dashboard.access_revoked_at,
        dashboard.purged_at
      INTO v_dashboard
    FROM dasher.dashboards AS dashboard
    WHERE dashboard.organization_id = p_organization_id
      AND dashboard.dashboard_id = NULLIF(current_setting(
        'dasher.run_dashboard_id', true
      ), '')::uuid
    FOR UPDATE;
    IF NOT FOUND OR v_lifecycle_policy.policy_revision IS NULL
      OR v_policy.policy_revision IS NULL OR NOT v_policy.enabled
      OR v_dashboard.lifecycle_state NOT IN ('draft', 'active')
      OR v_dashboard.access_revoked_at IS NOT NULL
      OR v_dashboard.purged_at IS NOT NULL
      OR (v_dashboard.current_kind = 'disposable'
        AND v_dashboard.effective_expires_at IS NOT NULL
        AND pg_catalog.statement_timestamp() >= v_dashboard.effective_expires_at)
    THEN
      RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
    END IF;
  END IF;
  PERFORM pg_catalog.set_config(
    'dasher.run_lock_run_id', p_source_run_id::text, true
  );
  PERFORM pg_catalog.set_config(
    'dasher.run_phase', CASE
      WHEN NULLIF(current_setting('dasher.security_function', true), '')
        = 'request_agent_run'
      THEN 'request_replay_locking' ELSE 'locking' END, true
  );
  SELECT source.* INTO v_source
  FROM dasher.agent_runs AS source
  WHERE source.organization_id = p_organization_id
    AND source.dashboard_id = NULLIF(current_setting(
      'dasher.run_dashboard_id', true
    ), '')::uuid
    AND source.run_id = p_source_run_id
    AND source.state = 'approval_required'
    AND source.candidate_set_sha256 IS NOT NULL
    AND source.selected_candidate_id IS NOT NULL
    AND source.request_payload_id IS NOT NULL
  FOR UPDATE;
  IF v_request_mode AND v_source IS DISTINCT FROM v_source_discovery THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  PERFORM pg_catalog.set_config('dasher.run_lock_run_id', '', true);
  PERFORM pg_catalog.set_config(
    'dasher.run_phase', 'replay_source_read', true
  );
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1
    FROM dasher.agent_recorded_results AS result
    WHERE result.organization_id = v_source.organization_id
      AND result.dashboard_id = v_source.dashboard_id
      AND result.run_id = v_source.run_id
    HAVING pg_catalog.count(*) BETWEEN 3 AND 5
      AND pg_catalog.min(result.result_sequence) = 1
      AND pg_catalog.max(result.result_sequence) = pg_catalog.count(*)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  SELECT payload.* INTO v_request
  FROM dasher.agent_run_request_payloads AS payload
  WHERE payload.organization_id = v_source.organization_id
    AND payload.dashboard_id = v_source.dashboard_id
    AND payload.request_payload_id = v_source.request_payload_id;
  IF NOT FOUND
    OR dasher_private.canonical_jsonb_bytes_v1(pg_catalog.convert_from(
      v_request.canonical_bytes, 'UTF8'
    )::jsonb) IS DISTINCT FROM v_request.canonical_bytes
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  v_request_body := pg_catalog.convert_from(
    v_request.canonical_bytes, 'UTF8'
  )::jsonb;
  BEGIN
    v_local_input_snapshot_id := NULLIF(current_setting(
      'dasher.run_lock_snapshot_id', true
    ), '')::uuid;
    v_source_input_snapshot_id := (
      v_request_body->>'input_snapshot_id'
    )::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END;
  IF v_source.dashboard_id <> NULLIF(current_setting(
      'dasher.run_dashboard_id', true
    ), '')::uuid
    OR v_request_body->>'purpose' <> 'suggest'
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  SELECT bundle.* INTO v_source_bundle
  FROM dasher.candidate_comparison_bundles AS bundle
  WHERE bundle.organization_id = v_source.organization_id
    AND bundle.dashboard_id = v_source.dashboard_id
    AND bundle.run_id = v_source.run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  SELECT brief.* INTO v_source_brief
  FROM dasher.briefs AS brief
  WHERE brief.organization_id = v_source.organization_id
    AND brief.dashboard_id = v_source.dashboard_id
    AND brief.run_id = v_source.run_id
    AND brief.common_bundle_id = v_source_bundle.bundle_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'evidence_id', member.evidence_id::text,
      'source_snapshot_id', member.source_snapshot_id::text,
      'evidence_sha256', pg_catalog.encode(member.evidence_sha256, 'hex'),
      'source_sha256', pg_catalog.encode(member.source_sha256, 'hex'),
      'freshness', member.freshness,
      'observed_at', pg_catalog.to_char(
        member.observed_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      )
    ) ORDER BY pg_catalog.uuid_send(member.evidence_id))
    INTO STRICT v_source_members
  FROM dasher.candidate_comparison_bundle_evidence AS member
  WHERE member.organization_id = v_source_bundle.organization_id
    AND member.dashboard_id = v_source_bundle.dashboard_id
    AND member.run_id = v_source_bundle.run_id
    AND member.bundle_id = v_source_bundle.bundle_id;

  PERFORM pg_catalog.set_config('dasher.run_phase', CASE
    WHEN v_request_mode THEN 'request_replay_locking'
    ELSE 'locking' END, true);
  IF NOT v_request_mode THEN
    PERFORM pg_catalog.set_config(
      'dasher.run_lock_run_id',
      NULLIF(current_setting('dasher.run_id', true), '')::uuid::text, true
    );
    SELECT bundle.* INTO v_local_bundle
    FROM dasher.candidate_comparison_bundles AS bundle
    WHERE bundle.organization_id = p_organization_id
      AND bundle.dashboard_id = v_source.dashboard_id
      AND bundle.run_id = NULLIF(current_setting(
        'dasher.run_id', true
      ), '')::uuid;
  END IF;
  FOR v_lock_snapshot_id IN
    SELECT candidate.snapshot_id
    FROM (VALUES
      (v_local_input_snapshot_id), (v_source_input_snapshot_id)
    ) AS candidate(snapshot_id)
    GROUP BY candidate.snapshot_id
    ORDER BY pg_catalog.uuid_send(candidate.snapshot_id)
  LOOP
    PERFORM pg_catalog.set_config(
      'dasher.run_lock_snapshot_id', v_lock_snapshot_id::text, true
    );
    SELECT snapshot.* INTO STRICT v_locked_snapshot
    FROM dasher.source_snapshots AS snapshot
    WHERE snapshot.organization_id = p_organization_id
      AND snapshot.snapshot_id = v_lock_snapshot_id
    FOR UPDATE;
    IF v_lock_snapshot_id = v_source_input_snapshot_id THEN
      v_source_snapshot := v_locked_snapshot;
    END IF;
    IF v_lock_snapshot_id = v_local_input_snapshot_id THEN
      v_local_snapshot := v_locked_snapshot;
    END IF;
  END LOOP;
  PERFORM pg_catalog.set_config('dasher.run_lock_snapshot_id', '', true);
  FOR v_member IN
    SELECT member.value
    FROM pg_catalog.jsonb_array_elements(v_source_members) AS member(value)
    ORDER BY pg_catalog.uuid_send((member.value->>'evidence_id')::uuid)
  LOOP
    PERFORM pg_catalog.set_config(
      'dasher.run_lock_evidence_id',
      (v_member.value->>'evidence_id')::uuid::text, true
    );
    SELECT evidence.* INTO STRICT v_locked_evidence
    FROM dasher.evidence_records AS evidence
    WHERE evidence.organization_id = p_organization_id
      AND evidence.evidence_id = (v_member.value->>'evidence_id')::uuid
    FOR UPDATE;
    IF v_locked_evidence.snapshot_id
          <> (v_member.value->>'source_snapshot_id')::uuid
      OR v_locked_evidence.content_sha256 <> pg_catalog.decode(
        v_member.value->>'evidence_sha256', 'hex'
      )
      OR v_locked_evidence.observed_at <> (
        v_member.value->>'observed_at'
      )::timestamptz
      OR v_source_snapshot.content_sha256 <> pg_catalog.decode(
        v_member.value->>'source_sha256', 'hex'
      )
    THEN
      RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
    END IF;
  END LOOP;
  PERFORM pg_catalog.set_config('dasher.run_lock_evidence_id', '', true);
  FOR v_lock_run_id IN
    SELECT candidate.run_id
    FROM (VALUES
      (v_source.run_id), (v_local_bundle.run_id)
    ) AS candidate(run_id)
    WHERE candidate.run_id IS NOT NULL
    GROUP BY candidate.run_id
    ORDER BY pg_catalog.uuid_send(candidate.run_id)
  LOOP
    PERFORM pg_catalog.set_config(
      'dasher.run_lock_run_id', v_lock_run_id::text, true
    );
    SELECT bundle.* INTO STRICT v_locked_bundle
    FROM dasher.candidate_comparison_bundles AS bundle
    WHERE bundle.organization_id = p_organization_id
      AND bundle.dashboard_id = v_source.dashboard_id
      AND bundle.run_id = v_lock_run_id
    FOR UPDATE;
    IF v_lock_run_id = v_source.run_id
      AND v_locked_bundle IS DISTINCT FROM v_source_bundle
    THEN
      RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
    END IF;
    IF v_lock_run_id = v_local_bundle.run_id
      AND v_locked_bundle IS DISTINCT FROM v_local_bundle
    THEN
      RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
    END IF;
  END LOOP;
  PERFORM pg_catalog.set_config('dasher.run_lock_run_id', '', true);
  IF v_request_mode THEN
    PERFORM pg_catalog.set_config(
      'dasher.run_lock_membership_id',
      v_source.requesting_membership_id::text, true
    );
    PERFORM pg_catalog.set_config(
      'dasher.run_lock_user_id', v_source.requesting_user_id::text, true
    );
    PERFORM pg_catalog.set_config(
      'dasher.run_lock_authority_revision',
      v_source.requesting_authority_revision::text, true
    );
    SELECT membership.user_id, membership.authority_revision,
        membership.state, membership.role, membership.revoked_at
      INTO v_revalidated_source_membership
    FROM dasher.memberships AS membership
    WHERE membership.organization_id = p_organization_id
      AND membership.membership_id = v_source.requesting_membership_id
      AND membership.user_id = v_source.requesting_user_id
      AND membership.authority_revision =
        v_source.requesting_authority_revision;
    PERFORM pg_catalog.set_config('dasher.run_lock_membership_id', '', true);
    PERFORM pg_catalog.set_config('dasher.run_lock_user_id', '', true);
    PERFORM pg_catalog.set_config(
      'dasher.run_lock_authority_revision', '', true
    );
    IF NOT FOUND OR v_revalidated_source_membership IS DISTINCT FROM
        v_source_membership THEN
      RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
    END IF;
  END IF;
  PERFORM pg_catalog.set_config('dasher.run_phase', 'replay_source_read', true);
  SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'evidence_id', member.evidence_id::text,
      'source_snapshot_id', member.source_snapshot_id::text,
      'evidence_sha256', pg_catalog.encode(member.evidence_sha256, 'hex'),
      'source_sha256', pg_catalog.encode(member.source_sha256, 'hex'),
      'freshness', member.freshness,
      'observed_at', pg_catalog.to_char(
        member.observed_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      )
    ) ORDER BY pg_catalog.uuid_send(member.evidence_id))
    INTO STRICT v_revalidated_members
  FROM dasher.candidate_comparison_bundle_evidence AS member
  WHERE member.organization_id = v_source_bundle.organization_id
    AND member.dashboard_id = v_source_bundle.dashboard_id
    AND member.run_id = v_source_bundle.run_id
    AND member.bundle_id = v_source_bundle.bundle_id;
  IF v_source_members IS NULL
    OR v_revalidated_members IS NULL
    OR v_source_snapshot.snapshot_id <> v_source_bundle.source_snapshot_id
    OR v_local_snapshot.content_sha256 IS DISTINCT FROM
      v_source_snapshot.content_sha256
    OR v_local_snapshot.canonical_bytes IS DISTINCT FROM
      v_source_snapshot.canonical_bytes
    OR v_source_snapshot.content_sha256 <> pg_catalog.decode(
      v_request_body->>'input_sha256', 'hex'
    )
    OR v_source_bundle.evidence_count <>
      pg_catalog.jsonb_array_length(v_source_members)
    OR v_source_bundle.bundle_sha256 <> pg_catalog.sha256(
      pg_catalog.convert_to('dasher.common-evidence-bundle.v1', 'UTF8')
      || pg_catalog.decode('00', 'hex')
      || pg_catalog.int4send(pg_catalog.octet_length(
        v_source_bundle.canonical_bytes
      )) || v_source_bundle.canonical_bytes
    )
    OR v_source_brief.brief_sha256 <> pg_catalog.sha256(
      pg_catalog.convert_to('dasher.agent-brief.v1', 'UTF8')
      || pg_catalog.decode('00', 'hex')
      || pg_catalog.int4send(pg_catalog.octet_length(
        v_source_brief.canonical_bytes
      )) || v_source_brief.canonical_bytes
    )
    OR v_revalidated_members IS DISTINCT FROM v_source_members
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  v_semantic_sha := pg_catalog.sha256(
    pg_catalog.convert_to('dasher.agent-run-request.v1', 'UTF8')
    || pg_catalog.decode('00', 'hex')
    || pg_catalog.int4send(pg_catalog.octet_length(v_request.canonical_bytes))
    || v_request.canonical_bytes
  );
  v_envelope_sha := pg_catalog.sha256(
    pg_catalog.convert_to('dasher.retained-payload-envelope.v1', 'UTF8')
    || pg_catalog.decode('00', 'hex')
    || pg_catalog.int4send(pg_catalog.octet_length('agent-run-request-v1'))
    || pg_catalog.convert_to('agent-run-request-v1', 'UTF8')
    || pg_catalog.int4send(pg_catalog.octet_length(v_request.content_nonce))
    || v_request.content_nonce
    || pg_catalog.int4send(pg_catalog.octet_length(v_semantic_sha))
    || v_semantic_sha
  );
  IF v_request.request_sha256 <> v_envelope_sha
    OR pg_catalog.convert_from(v_request.canonical_bytes, 'UTF8')::jsonb
      ->>'run_request_id' <> v_source.run_request_id::text
    OR pg_catalog.convert_from(v_request.canonical_bytes, 'UTF8')::jsonb
      ->>'dashboard_id' <> v_source.dashboard_id::text
    OR pg_catalog.convert_from(v_request.canonical_bytes, 'UTF8')::jsonb
      ->>'policy_revision' <> 'i64:' || v_source.policy_revision::text
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  FOR v_result IN
    SELECT result.*
    FROM dasher.agent_recorded_results AS result
    WHERE result.organization_id = v_source.organization_id
      AND result.dashboard_id = v_source.dashboard_id
      AND result.run_id = v_source.run_id
    ORDER BY result.result_sequence
  LOOP
    v_expected_sequence := v_expected_sequence + 1;
    v_semantic_sha := pg_catalog.sha256(
      pg_catalog.convert_to('dasher.recorded-result.v1', 'UTF8')
      || pg_catalog.decode('00', 'hex')
      || pg_catalog.int4send(pg_catalog.octet_length(v_result.canonical_bytes))
      || v_result.canonical_bytes
    );
    v_expected_head := pg_catalog.sha256(
      pg_catalog.convert_to('dasher.replay-result-head.v1', 'UTF8')
      || pg_catalog.decode('00', 'hex')
      || pg_catalog.uuid_send(v_source.run_id)
      || pg_catalog.int8send(v_result.result_sequence)
      || CASE WHEN v_prior_head IS NULL
        THEN pg_catalog.decode('00', 'hex')
        ELSE pg_catalog.decode('01', 'hex') || v_prior_head END
      || pg_catalog.uuid_send(v_result.result_id)
      || pg_catalog.int4send(pg_catalog.octet_length(v_result.result_kind))
      || pg_catalog.convert_to(v_result.result_kind, 'UTF8')
      || v_semantic_sha
    );
    SELECT payload.* INTO v_result_payload
    FROM dasher.agent_run_attempt_payloads AS payload
    WHERE payload.organization_id = v_result.organization_id
      AND payload.dashboard_id = v_result.dashboard_id
      AND payload.run_id = v_result.run_id
      AND payload.attempt_id = v_result.attempt_id
      AND payload.payload_kind = 'result'
      AND payload.payload_id = v_result.result_payload_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
    END IF;
    v_envelope_sha := pg_catalog.sha256(
      pg_catalog.convert_to('dasher.retained-payload-envelope.v1', 'UTF8')
      || pg_catalog.decode('00', 'hex')
      || pg_catalog.int4send(pg_catalog.octet_length('recorded-result-v1'))
      || pg_catalog.convert_to('recorded-result-v1', 'UTF8')
      || pg_catalog.int4send(pg_catalog.octet_length(
        v_result_payload.content_nonce
      ))
      || v_result_payload.content_nonce
      || pg_catalog.int4send(pg_catalog.octet_length(v_semantic_sha))
      || v_semantic_sha
    );
    IF v_result.result_sequence <> v_expected_sequence
      OR v_result.prior_result_head_sha256 IS DISTINCT FROM v_prior_head
      OR v_result.result_sha256 <> v_semantic_sha
      OR v_result.result_head_sha256 <> v_expected_head
      OR v_result_payload.canonical_bytes <> v_result.canonical_bytes
      OR v_result_payload.payload_sha256 <> v_envelope_sha
      OR dasher_private.canonical_jsonb_bytes_v1(pg_catalog.convert_from(
        v_result.canonical_bytes, 'UTF8'
      )::jsonb) IS DISTINCT FROM v_result.canonical_bytes
      OR pg_catalog.convert_from(v_result.canonical_bytes, 'UTF8')::jsonb
        ->>'result_id' <> v_result.result_id::text
      OR pg_catalog.convert_from(v_result.canonical_bytes, 'UTF8')::jsonb
        ->>'result_kind' <> v_result.result_kind
    THEN
      RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
    END IF;
    -- Keyed candidate-provenance proof for exactly the candidate-producing
    -- kinds, materialized from the canonical body this loop already validated.
    IF v_result.result_kind IN ('candidate_output', 'repair_output') THEN
      v_result_spec_bytes := dasher_private.canonical_dashboard_jsonb_bytes_v1(
        pg_catalog.convert_from(v_result.canonical_bytes, 'UTF8')::jsonb
          #> '{result,dashboard_spec}'
      );
      v_result_precommit_bytes := dasher_private.canonical_jsonb_bytes_v1(
        pg_catalog.convert_from(v_result.canonical_bytes, 'UTF8')::jsonb
          #> '{result,precommit_validation}'
      );
      IF v_result_spec_bytes IS NULL OR v_result_precommit_bytes IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
      END IF;
      v_source_candidate_results := v_source_candidate_results
        || pg_catalog.jsonb_build_object(
          v_result.result_id::text,
          pg_catalog.jsonb_build_object(
            'result_id', v_result.result_id::text,
            'result_sequence', 'i64:' || v_result.result_sequence::text,
            'result_kind', v_result.result_kind,
            'binding', pg_catalog.jsonb_build_object(
              'result_sha256', pg_catalog.encode(v_semantic_sha, 'hex'),
              'candidate_spec_bytes', pg_catalog.encode(
                v_result_spec_bytes, 'hex'
              ),
              'candidate_spec_sha256', pg_catalog.encode(pg_catalog.sha256(
                pg_catalog.convert_to('dasher.dashboard-spec.v1', 'UTF8')
                || pg_catalog.decode('00', 'hex')
                || pg_catalog.int4send(pg_catalog.octet_length(
                  v_result_spec_bytes
                )) || v_result_spec_bytes
              ), 'hex'),
              'precommit_validation_sha256', pg_catalog.encode(
                pg_catalog.sha256(
                  pg_catalog.convert_to(
                    'dasher.precommit-dashboard-validation.v1', 'UTF8'
                  )
                  || pg_catalog.decode('00', 'hex')
                  || pg_catalog.int4send(pg_catalog.octet_length(
                    v_result_precommit_bytes
                  )) || v_result_precommit_bytes
                ), 'hex'
              )
            )
          )
        );
    END IF;
    v_prior_head := v_expected_head;
  END LOOP;
  SELECT pg_catalog.jsonb_build_object(
      'materialized',
      v_source_candidate_results -> candidate.source_result_id::text,
      'bound', pg_catalog.jsonb_build_object(
        'result_sha256', pg_catalog.encode(
          candidate.source_result_sha256, 'hex'
        ),
        'candidate_spec_bytes', pg_catalog.encode(
          payload.canonical_bytes, 'hex'
        ),
        'candidate_spec_sha256', pg_catalog.encode(
          candidate.candidate_spec_sha256, 'hex'
        ),
        'precommit_validation_sha256', pg_catalog.encode(
          candidate.precommit_validation_sha256, 'hex'
        )
      )
    ) INTO v_selected_candidate_proof
  FROM dasher.agent_candidates AS candidate
  JOIN dasher.agent_candidate_payloads AS payload
    ON payload.organization_id = candidate.organization_id
   AND payload.dashboard_id = candidate.dashboard_id
   AND payload.run_id = candidate.run_id
   AND payload.candidate_id = candidate.candidate_id
  WHERE candidate.organization_id = v_source.organization_id
    AND candidate.dashboard_id = v_source.dashboard_id
    AND candidate.run_id = v_source.run_id
    AND candidate.candidate_id = v_source.selected_candidate_id
    AND candidate.selected
    AND candidate.common_bundle_id = v_source_bundle.bundle_id
    AND candidate.brief_id = v_source_brief.brief_id
    AND candidate.candidate_spec_sha256 = payload.candidate_spec_sha256
    AND candidate.candidate_spec_sha256 = pg_catalog.sha256(
      pg_catalog.convert_to('dasher.dashboard-spec.v1', 'UTF8')
      || pg_catalog.decode('00', 'hex')
      || pg_catalog.int4send(pg_catalog.octet_length(
        payload.canonical_bytes
      ))
      || payload.canonical_bytes
    );
  IF v_expected_sequence NOT BETWEEN 3 AND 5
    OR (
      NOT v_request_mode
      AND (
        v_local_request_body->>'input_sha256' IS DISTINCT FROM
          v_request_body->>'input_sha256'
        OR v_local_request_body->'field_catalog' IS DISTINCT FROM
          v_request_body->'field_catalog'
        OR v_local_request_body->'metric_contract_set' IS DISTINCT FROM
          v_request_body->'metric_contract_set'
        OR v_local_request_body->>'replay_source_result_count'
          IS DISTINCT FROM 'i64:' || v_expected_sequence::text
        OR v_local_request_body->>'replay_source_head_sha256'
          IS DISTINCT FROM pg_catalog.encode(v_prior_head, 'hex')
        OR v_local_request_body->>'replay_source_candidate_set_sha256'
          IS DISTINCT FROM pg_catalog.encode(
            v_source.candidate_set_sha256, 'hex'
          )
        OR v_local_request_body->>'replay_source_bundle_id'
          IS DISTINCT FROM v_source_bundle.bundle_id::text
        OR v_local_request_body->>'replay_source_bundle_sha256'
          IS DISTINCT FROM pg_catalog.encode(
            v_source_bundle.bundle_sha256, 'hex'
          )
        OR v_local_request_body->>'replay_source_brief_id'
          IS DISTINCT FROM v_source_brief.brief_id::text
        OR v_local_request_body->>'replay_source_brief_sha256'
          IS DISTINCT FROM pg_catalog.encode(v_source_brief.brief_sha256, 'hex')
        OR v_local_request_body->>'replay_source_selected_candidate_id'
          IS DISTINCT FROM v_source.selected_candidate_id::text
      )
    )
    OR NOT EXISTS (
      SELECT 1
      FROM dasher.agent_run_events AS event
      WHERE event.organization_id = v_source.organization_id
        AND event.dashboard_id = v_source.dashboard_id
        AND event.run_id = v_source.run_id
      HAVING pg_catalog.count(*) = v_source.current_event_sequence
        AND pg_catalog.count(event.event_payload_id) =
          v_source.current_event_sequence
        AND pg_catalog.min(event.event_sequence) = 1
        AND pg_catalog.max(event.event_sequence) =
          v_source.current_event_sequence
    )
    OR EXISTS (
      SELECT 1
      FROM dasher.agent_run_events AS event
      WHERE event.organization_id = v_source.organization_id
        AND event.dashboard_id = v_source.dashboard_id
        AND event.run_id = v_source.run_id
        AND (
          event.prior_event_sequence IS DISTINCT FROM CASE
            WHEN event.event_sequence = 1 THEN NULL
            ELSE event.event_sequence - 1 END
          OR event.prior_event_sha256 IS DISTINCT FROM (
            SELECT prior.event_sha256
            FROM dasher.agent_run_events AS prior
            WHERE prior.organization_id = event.organization_id
              AND prior.dashboard_id = event.dashboard_id
              AND prior.run_id = event.run_id
              AND prior.event_sequence = event.event_sequence - 1
          )
        )
    )
    OR v_source.current_event_sha256 IS DISTINCT FROM (
      SELECT event.event_sha256
      FROM dasher.agent_run_events AS event
      WHERE event.organization_id = v_source.organization_id
        AND event.dashboard_id = v_source.dashboard_id
        AND event.run_id = v_source.run_id
        AND event.event_sequence = v_source.current_event_sequence
    )
    OR v_selected_candidate_proof IS NULL
    OR v_selected_candidate_proof #> '{materialized,binding}' IS DISTINCT FROM
      v_selected_candidate_proof -> 'bound'
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  IF v_request_mode THEN
    PERFORM pg_catalog.set_config('dasher.run_phase', '', true);
    PERFORM pg_catalog.set_config('dasher.run_capability', '', true);
  ELSE
    PERFORM pg_catalog.set_config('dasher.run_phase', 'authorized', true);
    SELECT catalog.* INTO v_local_catalog
    FROM dasher.field_catalog_snapshots AS catalog
    WHERE catalog.organization_id = p_organization_id
      AND catalog.dashboard_id = v_source.dashboard_id
      AND catalog.catalog_snapshot_id = (
        v_local_request_body#>>'{field_catalog,catalog_snapshot_id}'
      )::uuid
      AND catalog.input_snapshot_id = v_local_input_snapshot_id
      AND catalog.canonical_bytes = dasher_private.canonical_jsonb_bytes_v1(
        v_local_request_body->'field_catalog'
      )
      AND catalog.catalog_sha256 = pg_catalog.sha256(
        pg_catalog.convert_to('dasher.field-catalog-snapshot.v1', 'UTF8')
        || pg_catalog.decode('00', 'hex')
        || pg_catalog.int4send(pg_catalog.octet_length(
          dasher_private.canonical_jsonb_bytes_v1(
            v_local_request_body->'field_catalog'
          )
        ))
        || dasher_private.canonical_jsonb_bytes_v1(
          v_local_request_body->'field_catalog'
        )
      );
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
    END IF;
    SELECT pg_catalog.count(*) INTO v_local_contract_count
    FROM dasher.metric_contract_versions AS contract
    WHERE contract.organization_id = p_organization_id
      AND contract.dashboard_id = v_source.dashboard_id
      AND contract.catalog_snapshot_id = v_local_catalog.catalog_snapshot_id
      AND contract.contract_set_id = (
        v_local_request_body#>>'{metric_contract_set,contract_set_id}'
      )::uuid
      AND contract.contract_set_sha256 = pg_catalog.sha256(
        pg_catalog.convert_to('dasher.metric-contract-set.v1', 'UTF8')
        || pg_catalog.decode('00', 'hex')
        || pg_catalog.int4send(pg_catalog.octet_length(
          dasher_private.canonical_jsonb_bytes_v1(
            v_local_request_body->'metric_contract_set'
          )
        ))
        || dasher_private.canonical_jsonb_bytes_v1(
          v_local_request_body->'metric_contract_set'
        )
      )
      AND contract.review_state = 'reviewed';
    IF v_local_contract_count IS DISTINCT FROM pg_catalog.jsonb_array_length(
        v_local_request_body#>'{metric_contract_set,contracts}'
      ) THEN
      RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
    END IF;
    IF v_local_bundle.run_id IS NOT NULL THEN
      SELECT brief.* INTO v_local_brief
      FROM dasher.briefs AS brief
      WHERE brief.organization_id = p_organization_id
        AND brief.dashboard_id = v_source.dashboard_id
        AND brief.run_id = NULLIF(current_setting(
          'dasher.run_id', true
        ), '')::uuid
        AND brief.brief_id = v_source_brief.brief_id
        AND brief.common_bundle_id = v_local_bundle.bundle_id;
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'evidence_id', member.evidence_id::text,
          'source_snapshot_id', member.source_snapshot_id::text,
          'evidence_sha256', pg_catalog.encode(member.evidence_sha256, 'hex'),
          'source_sha256', pg_catalog.encode(member.source_sha256, 'hex'),
          'freshness', member.freshness,
          'observed_at', pg_catalog.to_char(
            member.observed_at AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
          )
        ) ORDER BY pg_catalog.uuid_send(member.evidence_id))
        INTO v_local_members
      FROM dasher.candidate_comparison_bundle_evidence AS member
      WHERE member.organization_id = v_local_bundle.organization_id
        AND member.dashboard_id = v_local_bundle.dashboard_id
        AND member.run_id = v_local_bundle.run_id
        AND member.bundle_id = v_local_bundle.bundle_id;
      IF v_local_bundle.bundle_id <> v_source_bundle.bundle_id
        OR v_local_bundle.source_snapshot_id <>
          v_source_bundle.source_snapshot_id
        OR v_local_bundle.evidence_count <> v_source_bundle.evidence_count
        OR v_local_bundle.bundle_sha256 <> v_source_bundle.bundle_sha256
        OR v_local_bundle.canonical_bytes <> v_source_bundle.canonical_bytes
        OR v_local_members IS DISTINCT FROM v_source_members
        OR v_local_brief.brief_sha256 IS DISTINCT FROM
          v_source_brief.brief_sha256
        OR v_local_brief.canonical_bytes IS DISTINCT FROM
          v_source_brief.canonical_bytes
      THEN
        RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
      END IF;
    END IF;
    -- Provenance-only receipt for the one fixed capability that must bind the
    -- request-pinned selected candidate to the exact source result that
    -- produced it. Any absent value nulls the whole preimage and denies.
    IF NULLIF(current_setting('dasher.run_capability', true), '')
      = 'commit_candidate'
    THEN
      -- The selected candidate spec was committed under the source request's
      -- own evaluation instant, which the later local Replay request can never
      -- equal. Bind the two source-side texts here, from bytes this fence has
      -- already canonicalized and payload-proved, and carry that one value into
      -- the receipt so the consumer proves it without reading any source row.
      IF v_request_body->>'evaluation_time' IS NULL
        OR pg_catalog.convert_from(pg_catalog.decode(
          v_selected_candidate_proof
            #>> '{materialized,binding,candidate_spec_bytes}', 'hex'
        ), 'UTF8')::jsonb ->> 'generatedAt' IS NULL
        OR v_request_body->>'evaluation_time' IS DISTINCT FROM
          pg_catalog.convert_from(pg_catalog.decode(
            v_selected_candidate_proof
              #>> '{materialized,binding,candidate_spec_bytes}', 'hex'
          ), 'UTF8')::jsonb ->> 'generatedAt'
      THEN
        RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
      END IF;
      v_candidate_receipt_sha := pg_catalog.sha256(
        pg_catalog.convert_to('dasher.replay-candidate-receipt.v1', 'UTF8')
        || pg_catalog.decode('00', 'hex')
        || pg_catalog.uuid_send(p_organization_id)
        || pg_catalog.uuid_send(v_source.dashboard_id)
        || pg_catalog.uuid_send(NULLIF(current_setting(
          'dasher.run_id', true
        ), '')::uuid)
        || pg_catalog.uuid_send(p_source_run_id)
        || pg_catalog.uuid_send(v_local_request.request_payload_id)
        || v_local_request_semantic_sha
        || pg_catalog.int4send(pg_catalog.octet_length('commit_candidate'))
        || pg_catalog.convert_to('commit_candidate', 'UTF8')
        || pg_catalog.uuid_send(NULLIF(current_setting(
          'dasher.run_principal_id', true
        ), '')::uuid)
        || pg_catalog.int8send(NULLIF(current_setting(
          'dasher.run_principal_revision', true
        ), '')::bigint)
        || pg_catalog.decode(NULLIF(current_setting(
          'dasher.run_principal_sha256', true
        ), ''), 'hex')
        || pg_catalog.uuid_send(NULLIF(current_setting(
          'dasher.run_membership_id', true
        ), '')::uuid)
        || pg_catalog.uuid_send(NULLIF(current_setting(
          'dasher.run_user_id', true
        ), '')::uuid)
        || pg_catalog.int8send(NULLIF(current_setting(
          'dasher.run_authority_revision', true
        ), '')::bigint)
        || pg_catalog.int8send(NULLIF(current_setting(
          'dasher.run_policy_revision', true
        ), '')::bigint)
        || pg_catalog.int8send(NULLIF(current_setting(
          'dasher.run_lifecycle_policy_revision', true
        ), '')::bigint)
        || pg_catalog.uuid_send(v_source.selected_candidate_id)
        || pg_catalog.uuid_send((
          v_selected_candidate_proof #>> '{materialized,result_id}'
        )::uuid)
        || pg_catalog.int8send(pg_catalog.substr(
          v_selected_candidate_proof #>> '{materialized,result_sequence}', 5
        )::bigint)
        || pg_catalog.decode(
          v_selected_candidate_proof #>> '{materialized,binding,result_sha256}',
          'hex'
        )
        || pg_catalog.int4send(pg_catalog.octet_length(
          v_selected_candidate_proof #>> '{materialized,result_kind}'
        ))
        || pg_catalog.convert_to(
          v_selected_candidate_proof #>> '{materialized,result_kind}', 'UTF8'
        )
        || pg_catalog.decode(
          v_selected_candidate_proof
            #>> '{materialized,binding,candidate_spec_sha256}',
          'hex'
        )
        || pg_catalog.decode(
          v_selected_candidate_proof
            #>> '{materialized,binding,precommit_validation_sha256}',
          'hex'
        )
        || pg_catalog.uuid_send(v_source_bundle.bundle_id)
        || v_source_bundle.bundle_sha256
        || pg_catalog.uuid_send(v_source_brief.brief_id)
        || v_source_brief.brief_sha256
        || pg_catalog.int4send(pg_catalog.octet_length(
          v_request_body->>'evaluation_time'
        ))
        || pg_catalog.convert_to(v_request_body->>'evaluation_time', 'UTF8')
      );
      IF v_candidate_receipt_sha IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
      END IF;
      PERFORM pg_catalog.set_config(
        'dasher.run_replay_candidate_receipt_sha256',
        pg_catalog.encode(v_candidate_receipt_sha, 'hex'), true
      );
    END IF;
  END IF;
  RETURN v_source;
EXCEPTION
  WHEN SQLSTATE '22021' OR SQLSTATE '22P02' OR SQLSTATE '22003' THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
END
$function$;

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
  v_lifecycle_policy_revision bigint;
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
    'dasher.security_function', 'request_agent_run', true
  );
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
  IF p_purpose = 'suggest' THEN
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

    SELECT lifecycle_policy.policy_revision
      INTO v_lifecycle_policy_revision
    FROM dasher.dashboard_lifecycle_policies AS lifecycle_policy
    WHERE lifecycle_policy.organization_id = v_organization_id
      AND lifecycle_policy.policy_revision >= 1
      AND lifecycle_policy.retention_policy_revision >= 1
    ORDER BY lifecycle_policy.policy_revision DESC
    LIMIT 1
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
  ELSE
    -- Replay discovery is nonlocking. The private fence performs the complete
    -- requester/lifecycle/policy/dashboard/source prefix in canonical order.
    PERFORM 1 FROM dasher.memberships AS membership
    WHERE membership.organization_id = v_organization_id
      AND membership.membership_id = v_membership_id
      AND membership.user_id = v_user_id
      AND membership.authority_revision = v_authority_revision
      AND membership.state = 'active'
      AND membership.role IN ('editor', 'admin');
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
    END IF;
    SELECT lifecycle_policy.policy_revision
      INTO v_lifecycle_policy_revision
    FROM dasher.dashboard_lifecycle_policies AS lifecycle_policy
    WHERE lifecycle_policy.organization_id = v_organization_id
      AND lifecycle_policy.policy_revision >= 1
      AND lifecycle_policy.retention_policy_revision >= 1
    ORDER BY lifecycle_policy.policy_revision DESC
    LIMIT 1;
    SELECT policy.* INTO v_policy
    FROM dasher.agent_run_policy_revisions AS policy
    ORDER BY policy.policy_revision DESC
    LIMIT 1;
    IF v_lifecycle_policy_revision IS NULL OR NOT FOUND
      OR NOT v_policy.enabled
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
      );
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
    END IF;
  END IF;
  IF p_purpose = 'suggest' THEN
    SELECT snapshot.* INTO v_source
    FROM dasher.source_snapshots AS snapshot
    WHERE snapshot.organization_id = v_organization_id
      AND snapshot.snapshot_id = p_input_snapshot_id
      AND snapshot.content_sha256 = p_expected_input_sha256
    FOR UPDATE;
  ELSE
    SELECT snapshot.* INTO v_source
    FROM dasher.source_snapshots AS snapshot
    WHERE snapshot.organization_id = v_organization_id
      AND snapshot.snapshot_id = p_input_snapshot_id
      AND snapshot.content_sha256 = p_expected_input_sha256;
  END IF;
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
      'dasher.run_capability', 'replay_source_fence_request', true
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
    PERFORM pg_catalog.set_config('dasher.run_id', '', true);
    PERFORM pg_catalog.set_config(
      'dasher.run_replay_source_id', p_replay_source_run_id::text, true
    );
    PERFORM pg_catalog.set_config(
      'dasher.run_lock_snapshot_id', p_input_snapshot_id::text, true
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
    PERFORM pg_catalog.set_config(
      'dasher.run_lifecycle_policy_revision',
      v_lifecycle_policy_revision::text, true
    );
    PERFORM pg_catalog.set_config(
      'dasher.run_phase', 'request_replay_locking', true
    );
    v_replay_source := dasher_private.replay_source_fence_v1(
      v_organization_id, p_replay_source_run_id
    );
    PERFORM pg_catalog.set_config('dasher.run_phase', '', true);
    PERFORM pg_catalog.set_config('dasher.run_capability', '', true);
    PERFORM pg_catalog.set_config('dasher.run_id', '', true);
    PERFORM pg_catalog.set_config('dasher.run_replay_source_id', '', true);
    PERFORM pg_catalog.set_config('dasher.run_request_payload_id', '', true);
    PERFORM pg_catalog.set_config('dasher.run_membership_id', '', true);
    PERFORM pg_catalog.set_config('dasher.run_user_id', '', true);
    PERFORM pg_catalog.set_config('dasher.run_authority_revision', '', true);
    PERFORM pg_catalog.set_config('dasher.run_policy_revision', '', true);
    PERFORM pg_catalog.set_config(
      'dasher.run_lifecycle_policy_revision', '', true
    );
    PERFORM pg_catalog.set_config('dasher.run_lock_membership_id', '', true);
    PERFORM pg_catalog.set_config('dasher.run_lock_user_id', '', true);
    PERFORM pg_catalog.set_config(
      'dasher.run_lock_authority_revision', '', true
    );
    PERFORM pg_catalog.set_config('dasher.run_lock_run_id', '', true);
    PERFORM pg_catalog.set_config('dasher.run_lock_snapshot_id', '', true);
    PERFORM pg_catalog.set_config('dasher.run_lock_evidence_id', '', true);
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

CREATE OR REPLACE FUNCTION dasher_run_api.get_claimed_agent_run_input(
  p_run_id uuid,
  p_lease_epoch bigint,
  p_attempt_token bytea
)
RETURNS dasher_run_api.claimed_run_input_result
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_run dasher.agent_runs%ROWTYPE;
  v_payload dasher.agent_run_request_payloads%ROWTYPE;
  v_request jsonb;
  v_snapshot dasher.source_snapshots%ROWTYPE;
  v_catalog dasher.field_catalog_snapshots%ROWTYPE;
  v_contract record;
  v_policy dasher.agent_run_policy_revisions%ROWTYPE;
  v_source dasher.agent_runs%ROWTYPE;
  v_replay_bundle_id uuid;
  v_replay_bundle_sha bytea;
  v_replay_brief_id uuid;
  v_replay_brief_sha bytea;
  v_replay_result_count bigint;
  v_replay_final_sequence bigint;
  v_replay_result_head bytea;
  v_result dasher_run_api.claimed_run_input_result;
BEGIN
  PERFORM dasher_private.initialize_run_operator_context_v1(
    p_run_id, 'read_input'
  );
  PERFORM dasher_private.reauthorize_agent_run_v1(
    p_run_id, p_lease_epoch, p_attempt_token
  );
  IF NULLIF(current_setting(
    'dasher.run_replay_source_id', true
  ), '') IS NOT NULL THEN
    v_source := dasher_private.replay_source_fence_v1(
      NULLIF(current_setting('dasher.run_organization_id', true), '')::uuid,
      NULLIF(current_setting('dasher.run_replay_source_id', true), '')::uuid
    );
    PERFORM pg_catalog.set_config('dasher.run_phase', 'authorized', true);
  END IF;
  SELECT run.* INTO v_run
  FROM dasher.agent_runs AS run
  WHERE run.organization_id = current_setting(
      'dasher.run_organization_id', true
    )::uuid
    AND run.dashboard_id = current_setting('dasher.run_dashboard_id', true)::uuid
    AND run.run_id = p_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  SELECT payload.* INTO v_payload
  FROM dasher.agent_run_request_payloads AS payload
  WHERE payload.organization_id = v_run.organization_id
    AND payload.dashboard_id = v_run.dashboard_id
    AND payload.request_payload_id = v_run.request_payload_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  BEGIN
    v_request := pg_catalog.convert_from(v_payload.canonical_bytes, 'UTF8')::jsonb;
  EXCEPTION WHEN character_not_in_repertoire OR invalid_text_representation THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END;
  SELECT snapshot.* INTO v_snapshot
  FROM dasher.source_snapshots AS snapshot
  WHERE snapshot.organization_id = v_run.organization_id
    AND snapshot.snapshot_id = (v_request->>'input_snapshot_id')::uuid
    AND snapshot.content_sha256 = pg_catalog.decode(
      v_request->>'input_sha256', 'hex'
    )
    AND snapshot.canonical_bytes = dasher_private.canonical_jsonb_bytes_v1(
      v_request->'input_table'
    );
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  SELECT catalog.* INTO v_catalog
  FROM dasher.field_catalog_snapshots AS catalog
  WHERE catalog.organization_id = v_run.organization_id
    AND catalog.dashboard_id = v_run.dashboard_id
    AND catalog.catalog_snapshot_id = (
      v_request#>>'{field_catalog,catalog_snapshot_id}'
    )::uuid
    AND catalog.input_snapshot_id = v_snapshot.snapshot_id
    AND catalog.input_sha256 = v_snapshot.content_sha256
    AND catalog.catalog_sha256 = pg_catalog.sha256(
      pg_catalog.convert_to('dasher.field-catalog-snapshot.v1', 'UTF8')
      || pg_catalog.decode('00', 'hex')
      || pg_catalog.int4send(pg_catalog.octet_length(
        dasher_private.canonical_jsonb_bytes_v1(v_request->'field_catalog')
      ))
      || dasher_private.canonical_jsonb_bytes_v1(v_request->'field_catalog')
    )
    AND catalog.canonical_bytes = dasher_private.canonical_jsonb_bytes_v1(
      v_request->'field_catalog'
    );
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  SELECT contract.contract_set_id, contract.contract_set_sha256
    INTO v_contract
  FROM dasher.metric_contract_versions AS contract
  WHERE contract.organization_id = v_run.organization_id
    AND contract.dashboard_id = v_run.dashboard_id
    AND contract.catalog_snapshot_id = v_catalog.catalog_snapshot_id
    AND contract.contract_set_id = (
      v_request#>>'{metric_contract_set,contract_set_id}'
    )::uuid
    AND contract.contract_set_sha256 = pg_catalog.sha256(
      pg_catalog.convert_to('dasher.metric-contract-set.v1', 'UTF8')
      || pg_catalog.decode('00', 'hex')
      || pg_catalog.int4send(pg_catalog.octet_length(
        dasher_private.canonical_jsonb_bytes_v1(
          v_request->'metric_contract_set'
        )
      ))
      || dasher_private.canonical_jsonb_bytes_v1(
        v_request->'metric_contract_set'
      )
    )
    AND contract.review_state = 'reviewed'
  ORDER BY contract.contract_set_id, contract.contract_id, contract.contract_version
  LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  SELECT policy.* INTO v_policy
  FROM dasher.agent_run_policy_revisions AS policy
  WHERE policy.policy_revision = v_run.policy_revision;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;

  IF v_request->>'purpose' = 'replay' THEN
    IF v_source.organization_id <> v_run.organization_id
      OR v_source.dashboard_id <> v_run.dashboard_id
      OR v_source.run_id <> (v_request->>'replay_source_run_id')::uuid
      OR v_source.state <> 'approval_required'
    THEN
      RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
    END IF;
    v_replay_result_count := pg_catalog.substr(
      v_request->>'replay_source_result_count', 5
    )::bigint;
    v_replay_final_sequence := v_replay_result_count;
    v_replay_result_head := pg_catalog.decode(
      v_request->>'replay_source_head_sha256', 'hex'
    );
    v_replay_bundle_id := (
      v_request->>'replay_source_bundle_id'
    )::uuid;
    v_replay_bundle_sha := pg_catalog.decode(
      v_request->>'replay_source_bundle_sha256', 'hex'
    );
    v_replay_brief_id := (
      v_request->>'replay_source_brief_id'
    )::uuid;
    v_replay_brief_sha := pg_catalog.decode(
      v_request->>'replay_source_brief_sha256', 'hex'
    );
    IF v_replay_result_count NOT BETWEEN 3 AND 5
      OR v_source.candidate_set_sha256 <> pg_catalog.decode(
        v_request->>'replay_source_candidate_set_sha256', 'hex'
      )
      OR v_source.selected_candidate_id::text <>
        v_request->>'replay_source_selected_candidate_id'
    THEN
      RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
    END IF;
  END IF;

  v_result := ROW(
    v_run.run_id,
    v_request->>'purpose',
    v_run.requested_at,
    v_run.policy_revision,
    v_snapshot.snapshot_id,
    v_snapshot.content_sha256,
    v_catalog.input_row_count,
    v_catalog.catalog_snapshot_id,
    v_contract.contract_set_id,
    v_contract.contract_set_sha256,
    v_policy.generation_limit_vector,
    v_policy.review_limit_vector,
    v_source.run_id,
    v_replay_result_count::integer,
    v_replay_final_sequence,
    v_replay_result_head,
    v_source.candidate_set_sha256,
    v_replay_bundle_id,
    v_replay_bundle_sha,
    v_replay_brief_id,
    v_replay_brief_sha,
    v_source.selected_candidate_id,
    v_snapshot.canonical_bytes,
    v_payload.canonical_bytes
  )::dasher_run_api.claimed_run_input_result;
  RETURN v_result;
EXCEPTION WHEN no_data_found OR too_many_rows THEN
  RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
END
$function$;

CREATE OR REPLACE FUNCTION dasher_run_api.clone_claimed_replay_prerequisites(
  p_run_id uuid,
  p_lease_epoch bigint,
  p_attempt_token bytea
)
RETURNS dasher_run_api.replay_prerequisite_result
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_run dasher.agent_runs%ROWTYPE;
  v_request jsonb;
  v_source dasher.agent_runs%ROWTYPE;
  v_bundle dasher.candidate_comparison_bundles%ROWTYPE;
  v_brief dasher.briefs%ROWTYPE;
  v_local_bundle dasher.candidate_comparison_bundles%ROWTYPE;
  v_local_brief dasher.briefs%ROWTYPE;
  v_source_members jsonb;
  v_local_members jsonb;
  v_source_result_count bigint;
  v_source_result_head bytea;
  v_mutation dasher_run_api.run_mutation_result;
BEGIN
  PERFORM dasher_private.initialize_run_operator_context_v1(
    p_run_id, 'clone_replay'
  );
  PERFORM dasher_private.reauthorize_agent_run_v1(
    p_run_id, p_lease_epoch, p_attempt_token
  );
  IF NULLIF(current_setting('dasher.run_replay_source_id', true), '') IS NOT NULL THEN
    v_source := dasher_private.replay_source_fence_v1(
      NULLIF(current_setting('dasher.run_organization_id', true), '')::uuid,
      NULLIF(current_setting('dasher.run_replay_source_id', true), '')::uuid
    );
    IF current_setting('dasher.run_phase', true) <> 'authorized'
      OR NULLIF(current_setting('dasher.run_capability', true), '')
        IS DISTINCT FROM 'clone_replay'
      OR NULLIF(current_setting('dasher.run_organization_id', true), '')
        IS DISTINCT FROM v_source.organization_id::text
      OR NULLIF(current_setting('dasher.run_dashboard_id', true), '')
        IS DISTINCT FROM v_source.dashboard_id::text
      OR NULLIF(current_setting('dasher.run_id', true), '')
        IS DISTINCT FROM p_run_id::text
      OR NULLIF(current_setting('dasher.run_replay_source_id', true), '')
        IS DISTINCT FROM v_source.run_id::text
    THEN
      RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
    END IF;
    PERFORM pg_catalog.set_config('dasher.run_phase', 'replay_source_read', true);
  ELSE
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  SELECT source_bundle.* INTO STRICT v_bundle
  FROM dasher.candidate_comparison_bundles AS source_bundle
  WHERE source_bundle.organization_id = v_source.organization_id
    AND source_bundle.dashboard_id = v_source.dashboard_id
    AND source_bundle.run_id = v_source.run_id;
  SELECT source_brief.* INTO STRICT v_brief
  FROM dasher.briefs AS source_brief
  WHERE source_brief.organization_id = v_source.organization_id
    AND source_brief.dashboard_id = v_source.dashboard_id
    AND source_brief.run_id = v_source.run_id;
  SELECT pg_catalog.count(*), (
      pg_catalog.array_agg(
        result.result_head_sha256 ORDER BY result.result_sequence DESC
      )
    )[1]
    INTO STRICT v_source_result_count, v_source_result_head
  FROM dasher.agent_recorded_results AS result
  WHERE result.organization_id = v_source.organization_id
    AND result.dashboard_id = v_source.dashboard_id
    AND result.run_id = v_source.run_id;
  SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'evidence_id', member.evidence_id::text,
      'source_snapshot_id', member.source_snapshot_id::text,
      'evidence_sha256', pg_catalog.encode(member.evidence_sha256, 'hex'),
      'source_sha256', pg_catalog.encode(member.source_sha256, 'hex'),
      'freshness', member.freshness,
      'observed_at', pg_catalog.to_char(
        member.observed_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      )
    ) ORDER BY pg_catalog.uuid_send(member.evidence_id))
    INTO v_source_members
  FROM dasher.candidate_comparison_bundle_evidence AS member
  WHERE member.organization_id = v_source.organization_id
    AND member.dashboard_id = v_source.dashboard_id
    AND member.run_id = v_source.run_id
    AND member.bundle_id = v_bundle.bundle_id;
  PERFORM pg_catalog.set_config('dasher.run_phase', 'authorized', true);
  SELECT run.* INTO STRICT v_run
  FROM dasher.agent_runs AS run
  WHERE run.organization_id = current_setting(
      'dasher.run_organization_id', true
    )::uuid
    AND run.dashboard_id = current_setting('dasher.run_dashboard_id', true)::uuid
    AND run.run_id = p_run_id
  FOR UPDATE;
  SELECT pg_catalog.convert_from(payload.canonical_bytes, 'UTF8')::jsonb
    INTO STRICT v_request
  FROM dasher.agent_run_request_payloads AS payload
  WHERE payload.organization_id = v_run.organization_id
    AND payload.dashboard_id = v_run.dashboard_id
    AND payload.request_payload_id = v_run.request_payload_id;
  IF v_request->>'purpose' <> 'replay' THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  SELECT local_bundle.* INTO v_local_bundle
  FROM dasher.candidate_comparison_bundles AS local_bundle
  WHERE local_bundle.organization_id = v_run.organization_id
    AND local_bundle.dashboard_id = v_run.dashboard_id
    AND local_bundle.run_id = v_run.run_id;
  IF FOUND THEN
    SELECT local_brief.* INTO STRICT v_local_brief
    FROM dasher.briefs AS local_brief
    WHERE local_brief.organization_id = v_run.organization_id
      AND local_brief.dashboard_id = v_run.dashboard_id
      AND local_brief.run_id = v_run.run_id;
    SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'evidence_id', member.evidence_id::text,
        'source_snapshot_id', member.source_snapshot_id::text,
        'evidence_sha256', pg_catalog.encode(member.evidence_sha256, 'hex'),
        'source_sha256', pg_catalog.encode(member.source_sha256, 'hex'),
        'freshness', member.freshness,
        'observed_at', pg_catalog.to_char(
          member.observed_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        )
      ) ORDER BY pg_catalog.uuid_send(member.evidence_id))
      INTO v_local_members
    FROM dasher.candidate_comparison_bundle_evidence AS member
    WHERE member.organization_id = v_run.organization_id
      AND member.dashboard_id = v_run.dashboard_id
      AND member.run_id = v_run.run_id
      AND member.bundle_id = v_local_bundle.bundle_id;
    IF v_run.state <> 'planning'
      OR v_local_bundle.bundle_id <> v_bundle.bundle_id
      OR v_local_bundle.source_snapshot_id <> v_bundle.source_snapshot_id
      OR v_local_bundle.evidence_count <> v_bundle.evidence_count
      OR v_local_bundle.bundle_sha256 <> v_bundle.bundle_sha256
      OR v_local_bundle.canonical_bytes <> v_bundle.canonical_bytes
      OR v_local_brief.brief_id <> v_brief.brief_id
      OR v_local_brief.common_bundle_id <> v_brief.common_bundle_id
      OR v_local_brief.brief_sha256 <> v_brief.brief_sha256
      OR v_local_brief.canonical_bytes <> v_brief.canonical_bytes
      OR v_local_brief.created_at <> v_local_bundle.created_at
      OR v_local_members IS DISTINCT FROM v_source_members
      OR NOT EXISTS (
        SELECT 1
        FROM dasher.agent_run_events AS event
        WHERE event.organization_id = v_run.organization_id
          AND event.dashboard_id = v_run.dashboard_id
          AND event.run_id = v_run.run_id
          AND event.event_kind = 'replay_prerequisites_cloned'
          AND event.occurred_at = v_local_bundle.created_at
      )
    THEN
      RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
    END IF;
    v_mutation := ROW(
      v_run.run_id, v_run.run_revision, v_run.state,
      v_run.current_event_sequence, v_run.current_event_sha256,
      v_run.lease_epoch
    )::dasher_run_api.run_mutation_result;
    RETURN ROW(
      v_mutation, v_source.run_id, v_local_bundle.bundle_id,
      v_local_bundle.bundle_sha256, v_local_brief.brief_id,
      v_local_brief.brief_sha256
    )::dasher_run_api.replay_prerequisite_result;
  END IF;
  IF v_run.state <> 'authorized' THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;

  INSERT INTO dasher.candidate_comparison_bundles (
    organization_id, dashboard_id, run_id, bundle_id, source_snapshot_id,
    evidence_count, bundle_sha256, canonical_bytes, created_at
  ) VALUES (
    v_run.organization_id, v_run.dashboard_id, v_run.run_id,
    v_bundle.bundle_id, v_bundle.source_snapshot_id, v_bundle.evidence_count,
    v_bundle.bundle_sha256, v_bundle.canonical_bytes,
    pg_catalog.statement_timestamp()
  );
  INSERT INTO dasher.candidate_comparison_bundle_evidence (
    organization_id, dashboard_id, run_id, bundle_id, evidence_id,
    source_snapshot_id, evidence_sha256, source_sha256, freshness, observed_at
  )
  SELECT v_run.organization_id, v_run.dashboard_id, v_run.run_id,
    v_bundle.bundle_id, member.evidence_id::uuid,
    member.source_snapshot_id::uuid,
    pg_catalog.decode(member.evidence_sha256, 'hex'),
    pg_catalog.decode(member.source_sha256, 'hex'), member.freshness,
    member.observed_at::timestamptz
  FROM pg_catalog.jsonb_to_recordset(v_source_members) AS member(
    evidence_id text, source_snapshot_id text, evidence_sha256 text,
    source_sha256 text, freshness text, observed_at text
  )
  ORDER BY member.evidence_id::uuid;
  IF FOUND IS FALSE OR (
    SELECT pg_catalog.count(*)
    FROM dasher.candidate_comparison_bundle_evidence AS local_member
    WHERE local_member.organization_id = v_run.organization_id
      AND local_member.dashboard_id = v_run.dashboard_id
      AND local_member.run_id = v_run.run_id
      AND local_member.bundle_id = v_bundle.bundle_id
  ) <> v_bundle.evidence_count THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  INSERT INTO dasher.briefs (
    organization_id, dashboard_id, run_id, brief_id, common_bundle_id,
    brief_sha256, canonical_bytes, created_at
  ) VALUES (
    v_run.organization_id, v_run.dashboard_id, v_run.run_id,
    v_brief.brief_id, v_brief.common_bundle_id, v_brief.brief_sha256,
    v_brief.canonical_bytes, pg_catalog.statement_timestamp()
  );
  PERFORM pg_catalog.set_config('dasher.run_next_state', 'planning', true);
  v_mutation := dasher_private.append_agent_run_event_v1(
    v_run.run_id, dasher_private.uuid_v8_from_sha256_v1(pg_catalog.convert_to(pg_catalog.clock_timestamp()::text || '|' || pg_catalog.txid_current()::text || '|' || pg_catalog.random()::text, 'UTF8')),
    'replay_prerequisites_cloned',
    pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'brief_id', v_brief.brief_id::text,
      'brief_sha256', pg_catalog.encode(v_brief.brief_sha256, 'hex'),
      'bundle_id', v_bundle.bundle_id::text,
      'bundle_sha256', pg_catalog.encode(v_bundle.bundle_sha256, 'hex'),
      'candidate_set_sha256', pg_catalog.encode(
        v_source.candidate_set_sha256, 'hex'
      ),
      'result_count', 'i64:' || v_source_result_count::text,
      'result_head_sha256', pg_catalog.encode(v_source_result_head, 'hex'),
      'source_run_id', v_source.run_id::text
    )::text, 'UTF8')
  );
  RETURN ROW(
    v_mutation, v_source.run_id, v_bundle.bundle_id, v_bundle.bundle_sha256,
    v_brief.brief_id, v_brief.brief_sha256
  )::dasher_run_api.replay_prerequisite_result;
END
$function$;

CREATE OR REPLACE FUNCTION dasher_run_api.list_claimed_replay_results(
  p_run_id uuid,
  p_lease_epoch bigint,
  p_attempt_token bytea,
  p_after_source_sequence bigint,
  p_limit integer
)
RETURNS SETOF dasher_run_api.replay_source_result
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_request jsonb;
  v_source dasher.agent_runs%ROWTYPE;
BEGIN
  IF p_after_source_sequence < 0 OR p_limit NOT BETWEEN 1 AND 5 THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  PERFORM dasher_private.initialize_run_operator_context_v1(
    p_run_id, 'read_replay'
  );
  PERFORM dasher_private.reauthorize_agent_run_v1(
    p_run_id, p_lease_epoch, p_attempt_token
  );
  IF NULLIF(current_setting('dasher.run_replay_source_id', true), '') IS NOT NULL THEN
    v_source := dasher_private.replay_source_fence_v1(
      NULLIF(current_setting('dasher.run_organization_id', true), '')::uuid,
      NULLIF(current_setting('dasher.run_replay_source_id', true), '')::uuid
    );
    IF current_setting('dasher.run_phase', true) <> 'authorized'
      OR NULLIF(current_setting('dasher.run_capability', true), '')
        IS DISTINCT FROM 'read_replay'
      OR NULLIF(current_setting('dasher.run_organization_id', true), '')
        IS DISTINCT FROM v_source.organization_id::text
      OR NULLIF(current_setting('dasher.run_dashboard_id', true), '')
        IS DISTINCT FROM v_source.dashboard_id::text
      OR NULLIF(current_setting('dasher.run_id', true), '')
        IS DISTINCT FROM p_run_id::text
      OR NULLIF(current_setting('dasher.run_replay_source_id', true), '')
        IS DISTINCT FROM v_source.run_id::text
    THEN
      RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
    END IF;
    PERFORM pg_catalog.set_config('dasher.run_phase', 'replay_source_read', true);
  ELSE
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  RETURN QUERY
  SELECT
    v_source.run_id, result.result_sequence, result.result_sha256,
    result.result_kind, result.canonical_bytes
  FROM dasher.agent_recorded_results AS result
  WHERE result.organization_id = v_source.organization_id
    AND result.dashboard_id = v_source.dashboard_id
    AND result.run_id = v_source.run_id
    AND result.result_sequence > p_after_source_sequence
  ORDER BY result.result_sequence
  LIMIT p_limit;
  PERFORM pg_catalog.set_config('dasher.run_phase', 'authorized', true);
  SELECT pg_catalog.convert_from(payload.canonical_bytes, 'UTF8')::jsonb
    INTO STRICT v_request
  FROM dasher.agent_runs AS run
  JOIN dasher.agent_run_request_payloads AS payload
    ON payload.organization_id = run.organization_id
   AND payload.dashboard_id = run.dashboard_id
   AND payload.request_payload_id = run.request_payload_id
  WHERE run.organization_id = current_setting(
      'dasher.run_organization_id', true
    )::uuid
    AND run.run_id = p_run_id;
  IF v_request->>'purpose' <> 'replay' THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
END
$function$;

CREATE OR REPLACE FUNCTION dasher_run_api.consume_agent_replay_result(
  p_run_id uuid,
  p_lease_epoch bigint,
  p_attempt_token bytea,
  p_source_result_sequence bigint,
  p_source_result_sha256 bytea
)
RETURNS dasher_run_api.replay_consume_result
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_run dasher.agent_runs%ROWTYPE;
  v_request jsonb;
  v_source dasher.agent_runs%ROWTYPE;
  v_source_result dasher.agent_recorded_results%ROWTYPE;
  v_existing dasher.agent_recorded_results%ROWTYPE;
  v_mutation dasher_run_api.run_mutation_result;
  v_prior_head bytea;
  v_result_head bytea;
  v_next_sequence bigint;
  v_declared_result_count bigint;
BEGIN
  IF p_source_result_sequence NOT BETWEEN 1 AND 5
    OR pg_catalog.octet_length(p_source_result_sha256) <> 32
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  PERFORM dasher_private.initialize_run_operator_context_v1(
    p_run_id, 'consume_replay'
  );
  PERFORM dasher_private.reauthorize_agent_run_v1(
    p_run_id, p_lease_epoch, p_attempt_token
  );
  IF NULLIF(current_setting('dasher.run_replay_source_id', true), '') IS NOT NULL THEN
    v_source := dasher_private.replay_source_fence_v1(
      NULLIF(current_setting('dasher.run_organization_id', true), '')::uuid,
      NULLIF(current_setting('dasher.run_replay_source_id', true), '')::uuid
    );
    IF current_setting('dasher.run_phase', true) <> 'authorized'
      OR NULLIF(current_setting('dasher.run_capability', true), '')
        IS DISTINCT FROM 'consume_replay'
      OR NULLIF(current_setting('dasher.run_organization_id', true), '')
        IS DISTINCT FROM v_source.organization_id::text
      OR NULLIF(current_setting('dasher.run_dashboard_id', true), '')
        IS DISTINCT FROM v_source.dashboard_id::text
      OR NULLIF(current_setting('dasher.run_id', true), '')
        IS DISTINCT FROM p_run_id::text
      OR NULLIF(current_setting('dasher.run_replay_source_id', true), '')
        IS DISTINCT FROM v_source.run_id::text
    THEN
      RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
    END IF;
    PERFORM pg_catalog.set_config('dasher.run_phase', 'replay_source_read', true);
  ELSE
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  SELECT result.* INTO v_source_result
  FROM dasher.agent_recorded_results AS result
  WHERE result.organization_id = v_source.organization_id
    AND result.dashboard_id = v_source.dashboard_id
    AND result.run_id = v_source.run_id
    AND result.result_sequence = p_source_result_sequence
    AND result.result_sha256 = p_source_result_sha256;
  PERFORM pg_catalog.set_config('dasher.run_phase', 'authorized', true);
  SELECT run.* INTO STRICT v_run
  FROM dasher.agent_runs AS run
  WHERE run.organization_id = current_setting(
      'dasher.run_organization_id', true
    )::uuid
    AND run.run_id = p_run_id
  FOR UPDATE OF run;
  SELECT pg_catalog.convert_from(payload.canonical_bytes, 'UTF8')::jsonb
    INTO STRICT v_request
  FROM dasher.agent_run_request_payloads AS payload
  WHERE payload.organization_id = v_run.organization_id
    AND payload.dashboard_id = v_run.dashboard_id
    AND payload.request_payload_id = v_run.request_payload_id;
  IF v_request->>'purpose' <> 'replay'
    OR v_run.state NOT IN ('planning', 'generating')
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  IF v_request->>'replay_source_result_count' !~ '^i64:[3-5]$' THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  v_declared_result_count := pg_catalog.substr(
    v_request->>'replay_source_result_count', 5
  )::bigint;
  IF p_source_result_sequence > v_declared_result_count THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  SELECT local_result.* INTO v_existing
  FROM dasher.agent_recorded_results AS local_result
  WHERE local_result.organization_id = v_run.organization_id
    AND local_result.dashboard_id = v_run.dashboard_id
    AND local_result.run_id = v_run.run_id
    AND local_result.replay_source_result_sequence = p_source_result_sequence;
  IF FOUND THEN
    IF v_existing.replay_source_result_sha256 <> p_source_result_sha256 THEN
      RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
    END IF;
    v_mutation := ROW(
      v_run.run_id, v_run.run_revision, v_run.state,
      v_run.current_event_sequence, v_run.current_event_sha256, v_run.lease_epoch
    )::dasher_run_api.run_mutation_result;
    RETURN ROW(
      v_mutation, p_source_result_sequence, p_source_result_sha256,
      v_existing.result_id
    )::dasher_run_api.replay_consume_result;
  END IF;
  IF v_source_result.run_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  SELECT result.result_head_sha256 INTO v_prior_head
  FROM dasher.agent_recorded_results AS result
  WHERE result.organization_id = v_run.organization_id
    AND result.dashboard_id = v_run.dashboard_id
    AND result.run_id = v_run.run_id
  ORDER BY result.result_sequence DESC LIMIT 1;
  v_next_sequence := COALESCE(v_run.consumed_replay_sequence, 0) + 1;
  IF p_source_result_sequence <> v_next_sequence THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  v_result_head := pg_catalog.sha256(
    pg_catalog.convert_to('dasher.agent-recorded-result-head.v1', 'UTF8')
    || pg_catalog.decode('00', 'hex')
    || COALESCE(v_prior_head, ''::bytea) || v_source_result.result_sha256
  );
  INSERT INTO dasher.agent_recorded_results (
    organization_id, dashboard_id, run_id, result_sequence, result_id,
    attempt_id, result_payload_id, replay_source_run_id,
    replay_source_result_sequence, replay_source_result_sha256, result_kind,
    canonical_bytes, result_sha256, prior_result_head_sha256,
    result_head_sha256, created_at
  ) VALUES (
    v_run.organization_id, v_run.dashboard_id, v_run.run_id, v_next_sequence,
    v_source_result.result_id, NULL, NULL, v_source.run_id,
    v_source_result.result_sequence, v_source_result.result_sha256,
    v_source_result.result_kind, v_source_result.canonical_bytes,
    v_source_result.result_sha256, v_prior_head, v_result_head,
    pg_catalog.statement_timestamp()
  );
  PERFORM pg_catalog.set_config(
    'dasher.run_consumed_replay_sequence', v_next_sequence::text, true
  );
  PERFORM pg_catalog.set_config(
    'dasher.run_consumed_replay_sha256',
    pg_catalog.encode(v_source_result.result_sha256, 'hex'), true
  );
  IF v_next_sequence = v_declared_result_count THEN
    PERFORM pg_catalog.set_config('dasher.run_next_state', 'generating', true);
  END IF;
  v_mutation := dasher_private.append_agent_run_event_v1(
    v_run.run_id, dasher_private.uuid_v8_from_sha256_v1(pg_catalog.convert_to(pg_catalog.clock_timestamp()::text || '|' || pg_catalog.txid_current()::text || '|' || pg_catalog.random()::text, 'UTF8')), 'replay_result_consumed',
    pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'replay_result_id', v_source_result.result_id::text,
      'source_result_sha256', pg_catalog.encode(
        v_source_result.result_sha256, 'hex'
      ),
      'source_result_sequence', 'i64:' || v_next_sequence::text,
      'source_run_id', v_source.run_id::text
    )::text, 'UTF8')
  );
  RETURN ROW(
    v_mutation, v_next_sequence, v_source_result.result_sha256,
    v_source_result.result_id
  )::dasher_run_api.replay_consume_result;
END
$function$;

CREATE OR REPLACE FUNCTION dasher_run_api.write_agent_run_checkpoint(
  p_run_id uuid,
  p_lease_epoch bigint,
  p_attempt_token bytea,
  p_source_event_sequence bigint,
  p_source_event_sha256 bytea,
  p_canonical_checkpoint_bytes bytea
)
RETURNS dasher_run_api.checkpoint_commit_result
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_run dasher.agent_runs%ROWTYPE;
  v_existing dasher.agent_run_checkpoints%ROWTYPE;
  v_revision bigint;
  v_payload_id uuid := dasher_private.uuid_v8_from_sha256_v1(pg_catalog.convert_to(pg_catalog.clock_timestamp()::text || '|' || pg_catalog.txid_current()::text || '|' || pg_catalog.random()::text, 'UTF8'));
  v_nonce bytea := pg_catalog.uuid_send(dasher_private.uuid_v8_from_sha256_v1(pg_catalog.convert_to(pg_catalog.clock_timestamp()::text || '|' || pg_catalog.txid_current()::text || '|' || pg_catalog.random()::text, 'UTF8')))
    || pg_catalog.uuid_send(dasher_private.uuid_v8_from_sha256_v1(pg_catalog.convert_to(pg_catalog.clock_timestamp()::text || '|' || pg_catalog.txid_current()::text || '|' || pg_catalog.random()::text, 'UTF8')));
  v_state_sha bytea;
  v_checkpoint_sha bytea;
  v_mutation dasher_run_api.run_mutation_result;
  v_request_payload dasher.agent_run_request_payloads%ROWTYPE;
  v_request_body jsonb;
  v_reducer_event record;
  v_reducer_body jsonb;
  v_reduced_state text := 'requested';
  v_reduced_run_revision bigint := 0;
  v_reduced_lease_epoch bigint := 0;
  v_budget_counters jsonb;
  v_attempts jsonb;
  v_calculation_result_ids jsonb;
  v_candidate_ids jsonb;
  v_validation_states jsonb;
  v_latest_brief_sha text;
  v_latest_bundle_sha text;
  v_reduced_candidate_set_sha text;
  v_reduced_consumed_sequence text;
  v_reduced_consumed_sha text;
  v_reduced_purpose text;
  v_reduced_replay_source_run_id text;
  v_reduced_replay_source_result_count bigint;
  v_reduced_consumed_sequence_value bigint := 0;
  v_reducer_replay_result_id text;
  v_reducer_source_result_sequence text;
  v_reducer_source_result_sha text;
  v_reducer_source_run_id text;
  v_reduced_run_request_id text;
  v_reduced_request_idempotency_sha text;
  v_reduced_request_sha text;
  v_reduced_policy_revision text;
  v_expected_checkpoint jsonb;
  v_expected_checkpoint_bytes bytea;
BEGIN
  IF p_source_event_sequence < 1
    OR pg_catalog.octet_length(p_source_event_sha256) <> 32
    OR p_canonical_checkpoint_bytes IS NULL
    OR pg_catalog.octet_length(p_canonical_checkpoint_bytes) NOT BETWEEN 1 AND 262144
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  PERFORM dasher_private.initialize_run_operator_context_v1(
    p_run_id, 'checkpoint'
  );
  PERFORM dasher_private.reauthorize_agent_run_v1(
    p_run_id, p_lease_epoch, p_attempt_token
  );
  IF NULLIF(current_setting(
    'dasher.run_replay_source_id', true
  ), '') IS NOT NULL THEN
    PERFORM dasher_private.replay_source_fence_v1(
      NULLIF(current_setting('dasher.run_organization_id', true), '')::uuid,
      NULLIF(current_setting('dasher.run_replay_source_id', true), '')::uuid
    );
    PERFORM pg_catalog.set_config('dasher.run_phase', 'authorized', true);
  END IF;
  SELECT run.* INTO STRICT v_run
  FROM dasher.agent_runs AS run
  WHERE run.organization_id = current_setting(
      'dasher.run_organization_id', true
    )::uuid
    AND run.dashboard_id = current_setting('dasher.run_dashboard_id', true)::uuid
    AND run.run_id = p_run_id
  FOR UPDATE;
  IF p_source_event_sequence <> v_run.current_event_sequence
    OR p_source_event_sha256 <> v_run.current_event_sha256
    OR v_run.state NOT IN (
      'authorized','planning','generating','revising','validating'
    )
    OR v_run.lease_token_sha256 IS NULL
    OR v_run.lease_owner_principal_id <> current_setting(
      'dasher.run_principal_id', true
    )::uuid
    OR v_run.lease_owner_principal_revision <> current_setting(
      'dasher.run_principal_revision', true
    )::bigint
    OR v_run.terminal_operation_kind IS NOT NULL
    OR v_run.tenant_cancel_operation_id IS NOT NULL
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  PERFORM pg_catalog.set_config('dasher.run_phase', 'checkpoint_replay', true);
  PERFORM pg_catalog.set_config(
    'dasher.run_source_event_sequence', p_source_event_sequence::text, true
  );
  IF EXISTS (
    SELECT 1
    FROM dasher.agent_run_events AS event
    JOIN dasher.agent_run_event_payloads AS payload
      ON payload.organization_id = event.organization_id
     AND payload.dashboard_id = event.dashboard_id
     AND payload.run_id = event.run_id
     AND payload.event_payload_id = event.event_payload_id
     AND payload.event_id = event.event_id
     AND payload.event_sequence = event.event_sequence
    CROSS JOIN LATERAL (
      SELECT pg_catalog.sha256(
        pg_catalog.convert_to('dasher.agent-run-event-payload.v1', 'UTF8')
        || pg_catalog.decode('00', 'hex')
        || pg_catalog.int4send(pg_catalog.octet_length(payload.canonical_bytes))
        || payload.canonical_bytes
      ) AS semantic_sha
    ) AS semantic
    CROSS JOIN LATERAL (
      SELECT pg_catalog.sha256(
        pg_catalog.convert_to('dasher.retained-payload-envelope.v1', 'UTF8')
        || pg_catalog.decode('00', 'hex')
        || pg_catalog.int4send(
          pg_catalog.octet_length('agent-run-event-payload-v1')
        )
        || pg_catalog.convert_to('agent-run-event-payload-v1', 'UTF8')
        || pg_catalog.int4send(pg_catalog.octet_length(payload.content_nonce))
        || payload.content_nonce
        || pg_catalog.int4send(pg_catalog.octet_length(semantic.semantic_sha))
        || semantic.semantic_sha
      ) AS envelope_sha
    ) AS envelope
    WHERE event.organization_id = v_run.organization_id
      AND event.dashboard_id = v_run.dashboard_id
      AND event.run_id = v_run.run_id
      AND event.event_sequence BETWEEN 1 AND p_source_event_sequence
      AND (
        pg_catalog.octet_length(payload.content_nonce) <> 32
        OR payload.payload_sha256 <> envelope.envelope_sha
        OR event.event_sha256 <> pg_catalog.sha256(
          pg_catalog.convert_to('dasher.agent-run-event.v1', 'UTF8')
          || pg_catalog.decode('00', 'hex')
          || pg_catalog.uuid_send(event.run_id)
          || pg_catalog.int8send(event.event_sequence)
          || pg_catalog.int4send(pg_catalog.octet_length(event.event_kind))
          || pg_catalog.convert_to(event.event_kind, 'UTF8')
          || pg_catalog.int8send((
            extract(epoch FROM event.occurred_at) * 1000000
          )::bigint)
          || CASE WHEN event.prior_event_sequence IS NULL
            THEN pg_catalog.decode('00', 'hex')
            ELSE pg_catalog.decode('01', 'hex')
              || pg_catalog.int8send(event.prior_event_sequence) END
          || CASE WHEN event.prior_event_sha256 IS NULL
            THEN pg_catalog.decode('00', 'hex')
            ELSE pg_catalog.decode('01', 'hex')
              || event.prior_event_sha256 END
          || envelope.envelope_sha
        )
        OR event.prior_event_sequence IS DISTINCT FROM CASE
          WHEN event.event_sequence = 1 THEN NULL
          ELSE event.event_sequence - 1 END
        OR event.prior_event_sha256 IS DISTINCT FROM (
          SELECT prior.event_sha256
          FROM dasher.agent_run_events AS prior
          WHERE prior.organization_id = event.organization_id
            AND prior.dashboard_id = event.dashboard_id
            AND prior.run_id = event.run_id
            AND prior.event_sequence = event.event_sequence - 1
        )
        OR pg_catalog.jsonb_typeof(
          pg_catalog.convert_from(payload.canonical_bytes, 'UTF8')::jsonb
        ) <> 'object'
        OR (SELECT pg_catalog.count(*)
            FROM pg_catalog.jsonb_object_keys(
              pg_catalog.convert_from(payload.canonical_bytes, 'UTF8')::jsonb
            )) <> 11
        OR pg_catalog.convert_from(payload.canonical_bytes, 'UTF8')::jsonb
          ->>'schema' <> 'agent-run-event-payload-v1'
        OR pg_catalog.convert_from(payload.canonical_bytes, 'UTF8')::jsonb
          ->>'event_id' <> event.event_id::text
        OR pg_catalog.convert_from(payload.canonical_bytes, 'UTF8')::jsonb
          ->>'event_kind' <> event.event_kind
        OR pg_catalog.convert_from(payload.canonical_bytes, 'UTF8')::jsonb
          ->>'event_sequence' <> 'i64:' || event.event_sequence::text
        OR pg_catalog.convert_from(payload.canonical_bytes, 'UTF8')::jsonb
          ->>'run_id' <> event.run_id::text
      )
  ) OR (
    SELECT pg_catalog.count(*)
    FROM dasher.agent_run_events AS event
    WHERE event.organization_id = v_run.organization_id
      AND event.dashboard_id = v_run.dashboard_id
      AND event.run_id = v_run.run_id
      AND event.event_sequence BETWEEN 1 AND p_source_event_sequence
  ) <> p_source_event_sequence THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  PERFORM pg_catalog.set_config('dasher.run_phase', 'authorized', true);
  SELECT payload.* INTO STRICT v_request_payload
  FROM dasher.agent_run_request_payloads AS payload
  WHERE payload.organization_id = v_run.organization_id
    AND payload.dashboard_id = v_run.dashboard_id
    AND payload.request_payload_id = v_run.request_payload_id;
  v_request_body := pg_catalog.convert_from(
    v_request_payload.canonical_bytes, 'UTF8'
  )::jsonb;
  IF dasher_private.canonical_jsonb_bytes_v1(v_request_body)
      IS DISTINCT FROM v_request_payload.canonical_bytes
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  PERFORM pg_catalog.set_config('dasher.run_phase', 'checkpoint_replay', true);
  FOR v_reducer_event IN
    SELECT event.event_sequence, event.event_kind, payload.canonical_bytes
    FROM dasher.agent_run_events AS event
    JOIN dasher.agent_run_event_payloads AS payload
      ON payload.organization_id = event.organization_id
     AND payload.dashboard_id = event.dashboard_id
     AND payload.run_id = event.run_id
     AND payload.event_payload_id = event.event_payload_id
    WHERE event.organization_id = v_run.organization_id
      AND event.dashboard_id = v_run.dashboard_id
      AND event.run_id = v_run.run_id
      AND event.event_sequence BETWEEN 1 AND p_source_event_sequence
    ORDER BY event.event_sequence
  LOOP
    v_reducer_body := pg_catalog.convert_from(
      v_reducer_event.canonical_bytes, 'UTF8'
    )::jsonb;
    v_reduced_run_revision := v_reduced_run_revision + 1;
    IF v_reducer_body->>'run_revision' <>
        'i64:' || v_reduced_run_revision::text
    THEN
      RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
    END IF;
    CASE v_reducer_event.event_kind
      WHEN 'run_requested' THEN v_reduced_state := 'requested';
      WHEN 'lease_acquired' THEN
        IF v_reduced_state = 'requested' THEN
          v_reduced_state := 'authorized';
        ELSIF v_reduced_state NOT IN (
          'authorized', 'planning', 'generating', 'revising', 'validating'
        ) THEN
          RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
        END IF;
        v_reduced_lease_epoch := pg_catalog.substr(
          v_reducer_body#>>'{body,new_lease_epoch}', 5
        )::bigint;
      WHEN 'replay_prerequisites_cloned' THEN v_reduced_state := 'planning';
      WHEN 'replay_result_consumed' THEN
        v_reduced_purpose := v_request_body->>'purpose';
        v_reduced_replay_source_run_id :=
          v_request_body->>'replay_source_run_id';
        v_reducer_source_run_id :=
          v_reducer_body#>>'{body,source_run_id}';
        v_reducer_replay_result_id :=
          v_reducer_body#>>'{body,replay_result_id}';
        v_reducer_source_result_sequence :=
          v_reducer_body#>>'{body,source_result_sequence}';
        v_reducer_source_result_sha :=
          v_reducer_body#>>'{body,source_result_sha256}';
        IF v_reduced_state IS DISTINCT FROM 'planning'
          OR v_reduced_purpose IS DISTINCT FROM 'replay'
          OR (v_reduced_replay_source_run_id ~
            '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          ) IS DISTINCT FROM true
          OR (v_reducer_source_run_id ~
            '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          ) IS DISTINCT FROM true
          OR v_reducer_source_run_id IS DISTINCT FROM
            v_reduced_replay_source_run_id
          OR (v_reducer_replay_result_id ~
            '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          ) IS DISTINCT FROM true
          OR (v_reducer_source_result_sequence ~
            '^i64:(0|[1-9][0-9]*)$'
          ) IS DISTINCT FROM true
          OR (v_request_body->>'replay_source_result_count' ~
            '^i64:[3-5]$'
          ) IS DISTINCT FROM true
          OR (v_reducer_source_result_sha ~ '^[0-9a-f]{64}$')
            IS DISTINCT FROM true
        THEN
          RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
        END IF;
        v_reduced_replay_source_result_count := pg_catalog.substr(
          v_request_body->>'replay_source_result_count', 5
        )::bigint;
        v_reduced_consumed_sequence_value :=
          v_reduced_consumed_sequence_value + 1;
        IF v_reducer_source_result_sequence IS DISTINCT FROM
            'i64:' || v_reduced_consumed_sequence_value::text
          OR v_reduced_consumed_sequence_value >
            v_reduced_replay_source_result_count
        THEN
          RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
        END IF;
        v_reduced_consumed_sequence := v_reducer_source_result_sequence;
        v_reduced_consumed_sha := v_reducer_source_result_sha;
        IF v_reduced_consumed_sequence_value =
          v_reduced_replay_source_result_count
        THEN
          v_reduced_state := 'generating';
        END IF;
      WHEN 'attempt_reserved' THEN
        IF v_reducer_body#>>'{body,attempt_kind}' = 'planner' THEN
          v_reduced_state := 'planning';
        ELSIF v_reducer_body#>>'{body,attempt_kind}' IN (
          'specialist','generator'
        ) AND v_reduced_state = 'planning' THEN
          v_reduced_state := 'generating';
        ELSIF v_reducer_body#>>'{body,attempt_kind}' = 'repair' THEN
          v_reduced_state := 'revising';
        END IF;
      WHEN 'candidate_set_closed' THEN v_reduced_state := 'validating';
      ELSE NULL;
    END CASE;
  END LOOP;
  IF v_reduced_run_revision <> p_source_event_sequence
    OR v_reduced_run_revision <> v_run.run_revision
    OR v_reduced_state <> v_run.state
    OR v_reduced_lease_epoch <> v_run.lease_epoch
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  WITH event_bodies AS (
    SELECT event.event_sequence, event.event_kind,
      pg_catalog.convert_from(payload.canonical_bytes, 'UTF8')::jsonb
        ->'body' AS body
    FROM dasher.agent_run_events AS event
    JOIN dasher.agent_run_event_payloads AS payload
      ON payload.organization_id = event.organization_id
     AND payload.dashboard_id = event.dashboard_id
     AND payload.run_id = event.run_id
     AND payload.event_payload_id = event.event_payload_id
    WHERE event.organization_id = v_run.organization_id
      AND event.dashboard_id = v_run.dashboard_id
      AND event.run_id = v_run.run_id
      AND event.event_sequence <= p_source_event_sequence
  ), reservations AS (
    SELECT body->>'attempt_id' AS attempt_id, body->>'partition' AS partition,
      body->'reserved_vector' AS reserved_vector
    FROM event_bodies WHERE event_kind = 'attempt_reserved'
  ), fields(vector_field, ordinal) AS (VALUES
    ('calls',1),('candidates',2),('specialist_attempts',3),
    ('reviewer_attempts',4),('repair_attempts',5),('input_tokens',6),
    ('output_tokens',7),('reasoning_tokens',8),('cache_read_tokens',9),
    ('cache_write_tokens',10),('total_tokens',11),('wall_millis',12),
    ('work_millis',13),('cost_micros',14)
  ), partitions(partition, ordinal) AS (VALUES ('generation',1),('review',2))
  SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'partition', partition.partition,
      'vector_field', field.vector_field,
      'limit_units', v_request_body
        ->(partition.partition || '_limit_vector')->>field.vector_field,
      'reserved_units', 'i64:' || totals.reserved_units::text,
      'used_units', 'i64:' || totals.used_units::text,
      'released_units', 'i64:' || totals.released_units::text,
      'outstanding_units', 'i64:' || (
        totals.reserved_units - totals.used_units - totals.released_units
      )::text
    ) ORDER BY partition.ordinal, field.ordinal)
    INTO STRICT v_budget_counters
  FROM partitions AS partition
  CROSS JOIN fields AS field
  CROSS JOIN LATERAL (
    SELECT
      COALESCE((SELECT pg_catalog.sum(pg_catalog.substr(
          reservation.reserved_vector->>field.vector_field, 5
        )::bigint)
        FROM reservations AS reservation
        WHERE reservation.partition = partition.partition), 0) AS reserved_units,
      COALESCE((SELECT pg_catalog.sum(pg_catalog.substr(
          settlement.body->'used_vector'->>field.vector_field, 5
        )::bigint)
        FROM event_bodies AS settlement
        JOIN reservations AS reservation
          ON reservation.attempt_id = settlement.body->>'attempt_id'
        WHERE reservation.partition = partition.partition
          AND settlement.event_kind IN (
            'attempt_reconciled','attempt_indeterminate',
            'attempt_cancelled_released','attempt_cancelled_charged'
          )), 0) AS used_units,
      COALESCE((SELECT pg_catalog.sum(pg_catalog.substr(
          settlement.body->'released_vector'->>field.vector_field, 5
        )::bigint)
        FROM event_bodies AS settlement
        JOIN reservations AS reservation
          ON reservation.attempt_id = settlement.body->>'attempt_id'
        WHERE reservation.partition = partition.partition
          AND settlement.event_kind IN (
            'attempt_reconciled','attempt_indeterminate','attempt_released',
            'attempt_cancelled_released','attempt_cancelled_charged'
          )), 0) AS released_units
  ) AS totals;

  WITH event_bodies AS (
    SELECT event.event_sequence, event.event_kind,
      pg_catalog.convert_from(payload.canonical_bytes, 'UTF8')::jsonb
        ->'body' AS body
    FROM dasher.agent_run_events AS event
    JOIN dasher.agent_run_event_payloads AS payload
      ON payload.organization_id = event.organization_id
     AND payload.dashboard_id = event.dashboard_id
     AND payload.run_id = event.run_id
     AND payload.event_payload_id = event.event_payload_id
    WHERE event.organization_id = v_run.organization_id
      AND event.dashboard_id = v_run.dashboard_id
      AND event.run_id = v_run.run_id
      AND event.event_sequence <= p_source_event_sequence
  ), reservations AS (
    SELECT event_sequence, body
    FROM event_bodies WHERE event_kind = 'attempt_reserved'
  )
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'attempt_id', reservation.body->>'attempt_id',
      'attempt_kind', reservation.body->>'attempt_kind',
      'state', CASE latest.event_kind
        WHEN 'attempt_dispatch_prepared' THEN 'dispatch_ready'
        WHEN 'attempt_dispatch_started' THEN 'dispatch_started'
        WHEN 'attempt_reconciled' THEN CASE latest.body->>'outcome'
          WHEN 'succeeded' THEN 'succeeded'
          WHEN 'refused' THEN 'refused_charged'
          ELSE 'failed_charged' END
        WHEN 'attempt_indeterminate' THEN 'indeterminate_quarantined'
        WHEN 'attempt_released' THEN CASE latest.body->>'release_mode'
          WHEN 'takeover' THEN 'released_takeover'
          ELSE 'released_pre_dispatch' END
        WHEN 'attempt_cancelled_released' THEN 'cancelled_released'
        WHEN 'attempt_cancelled_charged' THEN 'cancelled_charged'
        ELSE 'reserved_pre_dispatch' END,
      'lease_epoch', lease.body->>'new_lease_epoch',
      'candidate_slot', reservation.body->'candidate_slot',
      'retry_of_attempt_id', reservation.body->'retry_of_attempt_id',
      'reserved_vector', reservation.body->'reserved_vector',
      'actual_vector', CASE WHEN latest.event_kind = 'attempt_reconciled'
        THEN latest.body->'actual_vector' ELSE NULL END,
      'used_vector', COALESCE(latest.body->'used_vector', zero.vector),
      'released_vector', COALESCE(latest.body->'released_vector', zero.vector),
      'outstanding_vector', (
        SELECT pg_catalog.jsonb_object_agg(
          field.key,
          'i64:' || (
            pg_catalog.substr(field.value, 5)::bigint
            - COALESCE(pg_catalog.substr(
                latest.body->'used_vector'->>field.key, 5
              )::bigint, 0)
            - COALESCE(pg_catalog.substr(
                latest.body->'released_vector'->>field.key, 5
              )::bigint, 0)
          )::text
          ORDER BY field.key
        )
        FROM pg_catalog.jsonb_each_text(
          reservation.body->'reserved_vector'
        ) AS field
      ),
      'request_sha256', reservation.body->>'request_sha256',
      'result_sha256', CASE WHEN latest.event_kind = 'attempt_reconciled'
        THEN latest.body->>'result_sha256' ELSE NULL END
    ) ORDER BY pg_catalog.uuid_send(
      (reservation.body->>'attempt_id')::uuid
    )), '[]'::jsonb)
    INTO v_attempts
  FROM reservations AS reservation
  LEFT JOIN LATERAL (
    SELECT event.event_kind, event.body
    FROM event_bodies AS event
    WHERE event.body->>'attempt_id' = reservation.body->>'attempt_id'
      AND event.event_kind IN (
        'attempt_dispatch_prepared','attempt_dispatch_started',
        'attempt_reconciled','attempt_indeterminate','attempt_released',
        'attempt_cancelled_released','attempt_cancelled_charged'
      )
    ORDER BY event.event_sequence DESC LIMIT 1
  ) AS latest ON true
  JOIN LATERAL (
    SELECT event.body
    FROM event_bodies AS event
    WHERE event.event_kind = 'lease_acquired'
      AND event.event_sequence < reservation.event_sequence
    ORDER BY event.event_sequence DESC LIMIT 1
  ) AS lease ON true
  CROSS JOIN LATERAL (
    SELECT pg_catalog.jsonb_object_agg(
      field.key, 'i64:0' ORDER BY field.key
    ) AS vector
    FROM pg_catalog.jsonb_each(
      reservation.body->'reserved_vector'
    ) AS field
  ) AS zero;

  WITH event_bodies AS (
    SELECT event.event_sequence, event.event_kind,
      pg_catalog.convert_from(payload.canonical_bytes, 'UTF8')::jsonb
        ->'body' AS body
    FROM dasher.agent_run_events AS event
    JOIN dasher.agent_run_event_payloads AS payload
      ON payload.organization_id = event.organization_id
     AND payload.dashboard_id = event.dashboard_id
     AND payload.run_id = event.run_id
     AND payload.event_payload_id = event.event_payload_id
    WHERE event.organization_id = v_run.organization_id
      AND event.dashboard_id = v_run.dashboard_id
      AND event.run_id = v_run.run_id
      AND event.event_sequence <= p_source_event_sequence
  ), candidates AS (
    SELECT body->>'candidate_id' AS candidate_id
    FROM event_bodies WHERE event_kind = 'candidate_committed'
  )
  SELECT COALESCE((SELECT pg_catalog.jsonb_agg(
      (body->>'result_id')::uuid ORDER BY (body->>'result_id')::uuid
    ) FROM event_bodies
      WHERE event_kind = 'calculation_graph_committed'), '[]'::jsonb),
    COALESCE((SELECT pg_catalog.jsonb_agg(
      candidate_id::uuid ORDER BY candidate_id::uuid
    ) FROM candidates), '[]'::jsonb),
    COALESCE((SELECT pg_catalog.jsonb_agg(COALESCE((
      SELECT validation.body->>'validation_state'
      FROM event_bodies AS validation
      WHERE validation.event_kind =
          'candidate_validation_findings_committed'
        AND validation.body->>'candidate_id' = candidate.candidate_id
      ORDER BY validation.event_sequence DESC LIMIT 1
    ), 'pending') ORDER BY candidate.candidate_id::uuid)
    FROM candidates AS candidate), '[]'::jsonb)
    INTO v_calculation_result_ids, v_candidate_ids, v_validation_states;
  SELECT body.value->>'brief_sha256' INTO v_latest_brief_sha
  FROM dasher.agent_run_events AS event
  JOIN dasher.agent_run_event_payloads AS payload
    ON payload.organization_id = event.organization_id
   AND payload.dashboard_id = event.dashboard_id
   AND payload.run_id = event.run_id
   AND payload.event_payload_id = event.event_payload_id
  CROSS JOIN LATERAL (
    SELECT pg_catalog.convert_from(payload.canonical_bytes, 'UTF8')::jsonb
      ->'body' AS value
  ) AS body
  WHERE event.organization_id = v_run.organization_id
    AND event.dashboard_id = v_run.dashboard_id
    AND event.run_id = v_run.run_id
    AND event.event_sequence <= p_source_event_sequence
    AND event.event_kind IN ('brief_committed','replay_prerequisites_cloned')
  ORDER BY event.event_sequence DESC LIMIT 1;
  SELECT body.value->>'bundle_sha256' INTO v_latest_bundle_sha
  FROM dasher.agent_run_events AS event
  JOIN dasher.agent_run_event_payloads AS payload
    ON payload.organization_id = event.organization_id
   AND payload.dashboard_id = event.dashboard_id
   AND payload.run_id = event.run_id
   AND payload.event_payload_id = event.event_payload_id
  CROSS JOIN LATERAL (
    SELECT pg_catalog.convert_from(payload.canonical_bytes, 'UTF8')::jsonb
      ->'body' AS value
  ) AS body
  WHERE event.organization_id = v_run.organization_id
    AND event.dashboard_id = v_run.dashboard_id
    AND event.run_id = v_run.run_id
    AND event.event_sequence <= p_source_event_sequence
    AND event.event_kind IN (
      'common_bundle_committed','replay_prerequisites_cloned'
    )
  ORDER BY event.event_sequence DESC LIMIT 1;
  SELECT body.value->>'candidate_set_sha256'
    INTO v_reduced_candidate_set_sha
  FROM dasher.agent_run_events AS event
  JOIN dasher.agent_run_event_payloads AS payload
    ON payload.organization_id = event.organization_id
   AND payload.dashboard_id = event.dashboard_id
   AND payload.run_id = event.run_id
   AND payload.event_payload_id = event.event_payload_id
  CROSS JOIN LATERAL (
    SELECT pg_catalog.convert_from(payload.canonical_bytes, 'UTF8')::jsonb
      ->'body' AS value
  ) AS body
  WHERE event.organization_id = v_run.organization_id
    AND event.dashboard_id = v_run.dashboard_id
    AND event.run_id = v_run.run_id
    AND event.event_sequence <= p_source_event_sequence
    AND event.event_kind = 'candidate_set_closed'
  ORDER BY event.event_sequence DESC LIMIT 1;
  SELECT body.value->>'source_result_sequence',
      body.value->>'source_result_sha256'
    INTO v_reduced_consumed_sequence, v_reduced_consumed_sha
  FROM dasher.agent_run_events AS event
  JOIN dasher.agent_run_event_payloads AS payload
    ON payload.organization_id = event.organization_id
   AND payload.dashboard_id = event.dashboard_id
   AND payload.run_id = event.run_id
   AND payload.event_payload_id = event.event_payload_id
  CROSS JOIN LATERAL (
    SELECT pg_catalog.convert_from(payload.canonical_bytes, 'UTF8')::jsonb
      ->'body' AS value
  ) AS body
  WHERE event.organization_id = v_run.organization_id
    AND event.dashboard_id = v_run.dashboard_id
    AND event.run_id = v_run.run_id
    AND event.event_sequence <= p_source_event_sequence
    AND event.event_kind = 'replay_result_consumed'
  ORDER BY event.event_sequence DESC LIMIT 1;
  SELECT body.value->>'run_request_id',
      body.value->>'request_idempotency_sha256',
      body.value->>'request_sha256', body.value->>'policy_revision'
    INTO v_reduced_run_request_id, v_reduced_request_idempotency_sha,
      v_reduced_request_sha, v_reduced_policy_revision
  FROM dasher.agent_run_events AS event
  JOIN dasher.agent_run_event_payloads AS payload
    ON payload.organization_id = event.organization_id
   AND payload.dashboard_id = event.dashboard_id
   AND payload.run_id = event.run_id
   AND payload.event_payload_id = event.event_payload_id
  CROSS JOIN LATERAL (
    SELECT pg_catalog.convert_from(payload.canonical_bytes, 'UTF8')::jsonb
      ->'body' AS value
  ) AS body
  WHERE event.organization_id = v_run.organization_id
    AND event.dashboard_id = v_run.dashboard_id
    AND event.run_id = v_run.run_id
    AND event.event_sequence <= p_source_event_sequence
    AND event.event_kind = 'run_requested'
  ORDER BY event.event_sequence LIMIT 1;
  PERFORM pg_catalog.set_config('dasher.run_phase', 'authorized', true);
  IF v_reduced_run_request_id <> v_run.run_request_id::text
    OR v_reduced_request_idempotency_sha <> pg_catalog.encode(
      v_request_payload.request_idempotency_sha256, 'hex'
    )
    OR v_reduced_request_sha <> pg_catalog.encode(
      v_request_payload.request_sha256, 'hex'
    )
    OR v_reduced_policy_revision <> 'i64:' || v_run.policy_revision::text
    OR v_reduced_candidate_set_sha IS DISTINCT FROM pg_catalog.encode(
      v_run.candidate_set_sha256, 'hex'
    )
    OR v_reduced_consumed_sequence IS DISTINCT FROM (CASE
      WHEN v_run.consumed_replay_sequence IS NULL THEN NULL
      ELSE 'i64:' || v_run.consumed_replay_sequence::text END)
    OR v_reduced_consumed_sha IS DISTINCT FROM pg_catalog.encode(
      v_run.consumed_replay_sha256, 'hex'
    )
    OR v_run.selected_candidate_id IS NOT NULL
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  v_expected_checkpoint := pg_catalog.jsonb_build_object(
    'schema', 'agent-run-checkpoint-v1',
    'run_id', v_run.run_id::text,
    'run_request_id', v_reduced_run_request_id,
    'request_idempotency_sha256', v_reduced_request_idempotency_sha,
    'request_sha256', v_reduced_request_sha,
    'policy_revision', v_reduced_policy_revision,
    'run_revision', 'i64:' || v_reduced_run_revision::text,
    'state', v_reduced_state,
    'lease_epoch', 'i64:' || v_reduced_lease_epoch::text,
    'source_event_sequence', 'i64:' || p_source_event_sequence::text,
    'source_event_sha256', pg_catalog.encode(p_source_event_sha256, 'hex'),
    'budget_counters', v_budget_counters,
    'attempts', v_attempts,
    'latest_brief_sha256', v_latest_brief_sha,
    'latest_bundle_sha256', v_latest_bundle_sha,
    'calculation_result_ids', v_calculation_result_ids,
    'candidate_ids', v_candidate_ids,
    'candidate_set_sha256', v_reduced_candidate_set_sha,
    'validation_states', v_validation_states,
    'consumed_replay_sequence', v_reduced_consumed_sequence,
    'consumed_replay_sha256', v_reduced_consumed_sha,
    'terminal_operation_kind', NULL,
    'terminal_operation_id', NULL,
    'terminal_claim_input_sha256', NULL,
    'terminal_operation_sha256', NULL,
    'tenant_cancel_operation_id', NULL,
    'tenant_cancel_operation_sha256', NULL,
    'tenant_cancel_result_sha256', NULL,
    'tenant_cancel_result_run_revision', NULL,
    'tenant_cancel_result_event_sequence', NULL,
    'tenant_cancel_result_event_sha256', NULL,
    'selected_candidate_id', NULL
  );
  v_expected_checkpoint_bytes :=
    dasher_private.canonical_jsonb_bytes_v1(v_expected_checkpoint);
  IF p_canonical_checkpoint_bytes <> v_expected_checkpoint_bytes THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  v_state_sha := pg_catalog.sha256(
    pg_catalog.convert_to('dasher.agent-run-checkpoint.v1', 'UTF8')
    || pg_catalog.decode('00', 'hex')
    || pg_catalog.int4send(pg_catalog.octet_length(v_expected_checkpoint_bytes))
    || v_expected_checkpoint_bytes
  );
  v_checkpoint_sha := pg_catalog.sha256(
    pg_catalog.convert_to('dasher.retained-payload-envelope.v1', 'UTF8')
    || pg_catalog.decode('00', 'hex')
    || pg_catalog.int4send(
      pg_catalog.octet_length('agent-run-checkpoint-v1')
    )
    || pg_catalog.convert_to('agent-run-checkpoint-v1', 'UTF8')
    || pg_catalog.int4send(pg_catalog.octet_length(v_nonce))
    || v_nonce
    || pg_catalog.int4send(pg_catalog.octet_length(v_state_sha))
    || v_state_sha
  );
  SELECT checkpoint.* INTO v_existing
  FROM dasher.agent_run_checkpoints AS checkpoint
  WHERE checkpoint.organization_id = v_run.organization_id
    AND checkpoint.dashboard_id = v_run.dashboard_id
    AND checkpoint.run_id = v_run.run_id
    AND checkpoint.source_event_sequence = p_source_event_sequence
    AND checkpoint.source_event_sha256 = p_source_event_sha256;
  IF FOUND THEN
    IF v_existing.state_sha256 <> v_state_sha THEN
      RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
    END IF;
    v_mutation := ROW(
      v_run.run_id, v_run.run_revision, v_run.state,
      v_run.current_event_sequence, v_run.current_event_sha256, v_run.lease_epoch
    )::dasher_run_api.run_mutation_result;
    RETURN ROW(
      v_mutation, v_existing.checkpoint_revision,
      v_existing.state_sha256, v_existing.checkpoint_sha256
    )::dasher_run_api.checkpoint_commit_result;
  END IF;
  v_revision := COALESCE(v_run.latest_checkpoint_revision, 0) + 1;
  INSERT INTO dasher.agent_run_checkpoint_payloads (
    organization_id, dashboard_id, run_id, checkpoint_payload_id,
    checkpoint_revision, content_nonce, canonical_bytes, state_sha256,
    checkpoint_sha256, created_at
  ) VALUES (
    v_run.organization_id, v_run.dashboard_id, v_run.run_id, v_payload_id,
    v_revision, v_nonce, v_expected_checkpoint_bytes, v_state_sha,
    v_checkpoint_sha, pg_catalog.statement_timestamp()
  );
  INSERT INTO dasher.agent_run_checkpoints (
    organization_id, dashboard_id, run_id, checkpoint_revision,
    source_event_sequence, source_event_sha256, state_sha256,
    checkpoint_sha256, checkpoint_payload_id, created_at
  ) VALUES (
    v_run.organization_id, v_run.dashboard_id, v_run.run_id, v_revision,
    p_source_event_sequence, p_source_event_sha256, v_state_sha,
    v_checkpoint_sha, v_payload_id, pg_catalog.statement_timestamp()
  );
  PERFORM pg_catalog.set_config(
    'dasher.run_latest_checkpoint_revision', v_revision::text, true
  );
  v_mutation := dasher_private.append_agent_run_event_v1(
    v_run.run_id, dasher_private.uuid_v8_from_sha256_v1(pg_catalog.convert_to(pg_catalog.clock_timestamp()::text || '|' || pg_catalog.txid_current()::text || '|' || pg_catalog.random()::text, 'UTF8')), 'checkpoint_written',
    pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'checkpoint_revision', 'i64:' || v_revision::text,
      'checkpoint_sha256', pg_catalog.encode(v_checkpoint_sha, 'hex'),
      'source_event_sequence', 'i64:' || p_source_event_sequence::text,
      'source_event_sha256', pg_catalog.encode(p_source_event_sha256, 'hex'),
      'state_sha256', pg_catalog.encode(v_state_sha, 'hex')
    )::text, 'UTF8')
  );
  RETURN ROW(
    v_mutation, v_revision, v_state_sha, v_checkpoint_sha
  )::dasher_run_api.checkpoint_commit_result;
END
$function$;

CREATE OR REPLACE FUNCTION dasher_run_api.commit_agent_brief(
  p_run_id uuid,
  p_lease_epoch bigint,
  p_attempt_token bytea,
  p_brief_id uuid,
  p_canonical_brief_bytes bytea
)
RETURNS dasher_run_api.content_commit_result
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_run dasher.agent_runs%ROWTYPE;
  v_policy dasher.agent_run_policy_revisions%ROWTYPE;
  v_run_request dasher.agent_run_request_payloads%ROWTYPE;
  v_bundle dasher.candidate_comparison_bundles%ROWTYPE;
  v_planner dasher.agent_run_attempts%ROWTYPE;
  v_planner_request dasher.agent_run_attempt_payloads%ROWTYPE;
  v_planner_result_payload dasher.agent_run_attempt_payloads%ROWTYPE;
  v_planner_result dasher.agent_recorded_results%ROWTYPE;
  v_body jsonb;
  v_run_request_body jsonb;
  v_planner_request_body jsonb;
  v_planner_result_body jsonb;
  v_planner_request_sha bytea;
  v_planner_result_sha bytea;
  v_sha bytea;
  v_body_brief_id uuid;
  v_bundle_id uuid;
  v_existing dasher.briefs%ROWTYPE;
  v_mutation dasher_run_api.run_mutation_result;
BEGIN
  IF p_brief_id IS NULL OR p_canonical_brief_bytes IS NULL
    OR pg_catalog.octet_length(p_canonical_brief_bytes) NOT BETWEEN 1 AND 32768
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  PERFORM dasher_private.initialize_run_operator_context_v1(p_run_id, 'commit_brief');
  PERFORM dasher_private.reauthorize_agent_run_v1(
    p_run_id, p_lease_epoch, p_attempt_token
  );
  SELECT run.* INTO STRICT v_run
  FROM dasher.agent_runs AS run
  WHERE run.organization_id = current_setting(
      'dasher.run_organization_id', true
    )::uuid AND run.run_id = p_run_id
  FOR UPDATE;
  BEGIN
    v_body := pg_catalog.convert_from(p_canonical_brief_bytes, 'UTF8')::jsonb;
    v_body_brief_id := (v_body->>'brief_id')::uuid;
    v_bundle_id := (v_body->>'bundle_id')::uuid;
  EXCEPTION WHEN data_exception THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END;
  IF v_run.state <> 'planning' OR v_body->>'schema' <> 'agent-brief-v1'
    OR v_body_brief_id <> p_brief_id
    OR (v_body->>'candidate_target_count') NOT IN ('i64:1', 'i64:2')
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  SELECT bundle.* INTO v_bundle
  FROM dasher.candidate_comparison_bundles AS bundle
  WHERE bundle.organization_id = v_run.organization_id
    AND bundle.dashboard_id = v_run.dashboard_id AND bundle.run_id = v_run.run_id
    AND bundle.bundle_id = v_bundle_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  SELECT policy.* INTO STRICT v_policy
  FROM dasher.agent_run_policy_revisions AS policy
  WHERE policy.policy_revision = v_run.policy_revision;
  SELECT payload.* INTO STRICT v_run_request
  FROM dasher.agent_run_request_payloads AS payload
  WHERE payload.organization_id = v_run.organization_id
    AND payload.dashboard_id = v_run.dashboard_id
    AND payload.request_payload_id = v_run.request_payload_id;
  SELECT attempt.* INTO v_planner
  FROM dasher.agent_run_attempts AS attempt
  WHERE attempt.organization_id = v_run.organization_id
    AND attempt.dashboard_id = v_run.dashboard_id
    AND attempt.run_id = v_run.run_id
    AND attempt.attempt_kind = 'planner'
    AND attempt.candidate_slot IS NULL
    AND attempt.retry_of_attempt_id IS NULL;
  IF NOT FOUND OR (
    SELECT pg_catalog.count(*)
    FROM dasher.agent_run_attempts AS attempt
    WHERE attempt.organization_id = v_run.organization_id
      AND attempt.dashboard_id = v_run.dashboard_id
      AND attempt.run_id = v_run.run_id
      AND attempt.attempt_kind = 'planner'
      AND attempt.candidate_slot IS NULL
      AND attempt.retry_of_attempt_id IS NULL
  ) <> 1
    OR v_planner.state <> 'succeeded'
    OR v_planner.result_payload_id IS NULL
    OR v_planner.reconciled_at IS NULL
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  SELECT payload.* INTO v_planner_request
  FROM dasher.agent_run_attempt_payloads AS payload
  WHERE payload.organization_id = v_run.organization_id
    AND payload.dashboard_id = v_run.dashboard_id
    AND payload.run_id = v_run.run_id
    AND payload.attempt_id = v_planner.attempt_id
    AND payload.payload_kind = 'request'
    AND payload.payload_id = v_planner.request_payload_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  SELECT payload.* INTO v_planner_result_payload
  FROM dasher.agent_run_attempt_payloads AS payload
  WHERE payload.organization_id = v_run.organization_id
    AND payload.dashboard_id = v_run.dashboard_id
    AND payload.run_id = v_run.run_id
    AND payload.attempt_id = v_planner.attempt_id
    AND payload.payload_kind = 'result'
    AND payload.payload_id = v_planner.result_payload_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  SELECT result.* INTO v_planner_result
  FROM dasher.agent_recorded_results AS result
  WHERE result.organization_id = v_run.organization_id
    AND result.dashboard_id = v_run.dashboard_id
    AND result.run_id = v_run.run_id
    AND result.attempt_id = v_planner.attempt_id
    AND result.result_payload_id = v_planner.result_payload_id
    AND result.result_kind = 'planner_output';
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  BEGIN
    v_run_request_body := pg_catalog.convert_from(
      v_run_request.canonical_bytes, 'UTF8'
    )::jsonb;
    v_planner_request_body := pg_catalog.convert_from(
      v_planner_request.canonical_bytes, 'UTF8'
    )::jsonb;
    v_planner_result_body := pg_catalog.convert_from(
      v_planner_result.canonical_bytes, 'UTF8'
    )::jsonb;
  EXCEPTION
    WHEN SQLSTATE '22021' OR SQLSTATE '22P02' THEN
      RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END;
  v_planner_request_sha := pg_catalog.sha256(
    pg_catalog.convert_to('dasher.attempt-request.v1', 'UTF8')
    || pg_catalog.decode('00', 'hex')
    || pg_catalog.int4send(pg_catalog.octet_length(
      v_planner_request.canonical_bytes
    )) || v_planner_request.canonical_bytes
  );
  v_planner_result_sha := pg_catalog.sha256(
    pg_catalog.convert_to('dasher.recorded-result.v1', 'UTF8')
    || pg_catalog.decode('00', 'hex')
    || pg_catalog.int4send(pg_catalog.octet_length(
      v_planner_result.canonical_bytes
    )) || v_planner_result.canonical_bytes
  );
  IF dasher_private.canonical_jsonb_bytes_v1(v_run_request_body)
      IS DISTINCT FROM v_run_request.canonical_bytes
    OR dasher_private.canonical_jsonb_bytes_v1(v_planner_request_body)
      IS DISTINCT FROM v_planner_request.canonical_bytes
    OR dasher_private.canonical_jsonb_bytes_v1(v_planner_result_body)
      IS DISTINCT FROM v_planner_result.canonical_bytes
    OR v_planner_request_body->>'schema' <> 'attempt-request-v1'
    OR v_planner_request_body->>'attempt_id' <> v_planner.attempt_id::text
    OR v_planner_request_body->>'attempt_kind' <> 'planner'
    OR v_planner_request_body->>'input_sha256' <>
      v_run_request_body->>'input_sha256'
    OR v_planner_request_body->>'common_bundle_sha256' <>
      pg_catalog.encode(v_bundle.bundle_sha256, 'hex')
    OR v_planner_request_body->>'instructions_sha256' <>
      pg_catalog.encode(v_policy.planner_instructions_sha256, 'hex')
    OR v_planner_result_payload.canonical_bytes IS DISTINCT FROM
      v_planner_result.canonical_bytes
    OR v_planner_result.result_sha256 IS DISTINCT FROM v_planner_result_sha
    OR v_planner_result_body->>'schema' <> 'recorded-result-v1'
    OR v_planner_result_body->>'result_id' <> v_planner_result.result_id::text
    OR v_planner_result_body->>'attempt_id' <> v_planner.attempt_id::text
    OR v_planner_result_body->>'attempt_kind' <> 'planner'
    OR v_planner_result_body->>'request_sha256' <>
      pg_catalog.encode(v_planner_request_sha, 'hex')
    OR v_planner_result_body->>'result_kind' <> 'planner_output'
    OR dasher_private.canonical_jsonb_bytes_v1(
      v_planner_result_body->'result'
    ) IS DISTINCT FROM p_canonical_brief_bytes
    OR v_planner_result.result_head_sha256 IS DISTINCT FROM pg_catalog.sha256(
      pg_catalog.convert_to('dasher.replay-result-head.v1', 'UTF8')
      || pg_catalog.decode('00', 'hex')
      || pg_catalog.uuid_send(v_planner_result.run_id)
      || pg_catalog.int8send(v_planner_result.result_sequence)
      || CASE WHEN v_planner_result.prior_result_head_sha256 IS NULL
        THEN pg_catalog.decode('00', 'hex')
        ELSE pg_catalog.decode('01', 'hex')
          || v_planner_result.prior_result_head_sha256 END
      || pg_catalog.uuid_send(v_planner_result.result_id)
      || pg_catalog.int4send(pg_catalog.octet_length(
        v_planner_result.result_kind
      )) || pg_catalog.convert_to(v_planner_result.result_kind, 'UTF8')
      || v_planner_result.result_sha256
    )
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  v_sha := pg_catalog.sha256(
    pg_catalog.convert_to('dasher.agent-brief.v1', 'UTF8')
    || pg_catalog.decode('00', 'hex')
    || pg_catalog.int4send(pg_catalog.octet_length(p_canonical_brief_bytes))
    || p_canonical_brief_bytes
  );
  SELECT brief.* INTO v_existing FROM dasher.briefs AS brief
  WHERE brief.organization_id = v_run.organization_id
    AND brief.dashboard_id = v_run.dashboard_id AND brief.run_id = v_run.run_id;
  IF FOUND THEN
    IF v_existing.brief_id <> p_brief_id OR v_existing.brief_sha256 <> v_sha THEN
      RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
    END IF;
    RETURN ROW(
      ROW(v_run.run_id, v_run.run_revision, v_run.state,
        v_run.current_event_sequence, v_run.current_event_sha256,
        v_run.lease_epoch)::dasher_run_api.run_mutation_result,
      p_brief_id, v_sha
    )::dasher_run_api.content_commit_result;
  END IF;
  INSERT INTO dasher.briefs (
    organization_id, dashboard_id, run_id, brief_id, common_bundle_id,
    brief_sha256, canonical_bytes, created_at
  ) VALUES (
    v_run.organization_id, v_run.dashboard_id, v_run.run_id, p_brief_id,
    v_bundle_id, v_sha, p_canonical_brief_bytes, pg_catalog.statement_timestamp()
  );
  v_mutation := dasher_private.append_agent_run_event_v1(
    v_run.run_id, dasher_private.uuid_v8_from_sha256_v1(pg_catalog.convert_to(pg_catalog.clock_timestamp()::text || '|' || pg_catalog.txid_current()::text || '|' || pg_catalog.random()::text, 'UTF8')), 'brief_committed',
    pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'brief_id', p_brief_id::text,
      'brief_sha256', pg_catalog.encode(v_sha, 'hex')
    )::text, 'UTF8')
  );
  RETURN ROW(v_mutation, p_brief_id, v_sha)::dasher_run_api.content_commit_result;
END
$function$;

CREATE OR REPLACE FUNCTION dasher_run_api.commit_common_evidence_bundle(
  p_run_id uuid,
  p_lease_epoch bigint,
  p_attempt_token bytea,
  p_bundle_id uuid,
  p_canonical_bundle_bytes bytea
)
RETURNS dasher_run_api.content_commit_result
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_run dasher.agent_runs%ROWTYPE;
  v_request_payload dasher.agent_run_request_payloads%ROWTYPE;
  v_source dasher.source_snapshots%ROWTYPE;
  v_catalog dasher.field_catalog_snapshots%ROWTYPE;
  v_locked_evidence dasher.evidence_records%ROWTYPE;
  v_body jsonb;
  v_request jsonb;
  v_rebuilt_field_catalog jsonb;
  v_rebuilt_contract_set jsonb;
  v_compact_body text := '';
  v_sha bytea;
  v_request_semantic_sha bytea;
  v_contract_set_sha bytea;
  v_source_snapshot_id uuid;
  v_request_source_snapshot_id uuid;
  v_catalog_snapshot_id uuid;
  v_contract_set_id uuid;
  v_count bigint;
  v_entry jsonb;
  v_mutation dasher_run_api.run_mutation_result;
  v_existing dasher.candidate_comparison_bundles%ROWTYPE;
BEGIN
  IF p_bundle_id IS NULL OR p_canonical_bundle_bytes IS NULL
    OR pg_catalog.octet_length(p_canonical_bundle_bytes) NOT BETWEEN 1 AND 262144
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  PERFORM dasher_private.initialize_run_operator_context_v1(p_run_id, 'commit_bundle');
  PERFORM dasher_private.reauthorize_agent_run_v1(
    p_run_id, p_lease_epoch, p_attempt_token
  );
  SELECT run.* INTO STRICT v_run FROM dasher.agent_runs AS run
  WHERE run.organization_id = current_setting(
      'dasher.run_organization_id', true
    )::uuid AND run.run_id = p_run_id
  FOR UPDATE;
  BEGIN
    v_body := pg_catalog.convert_from(p_canonical_bundle_bytes, 'UTF8')::jsonb;
  EXCEPTION WHEN data_exception THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END;
  IF v_run.state <> 'authorized'
    OR v_body->>'schema' <> 'common-evidence-bundle-v1'
    OR (v_body->>'bundle_id')::uuid <> p_bundle_id
    OR pg_catalog.jsonb_typeof(v_body->'entries') <> 'array'
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(v_body)) <> 4
    OR NOT v_body ?& ARRAY[
      'schema','bundle_id','source_snapshot_id','entries'
    ]
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  v_compact_body := pg_catalog.convert_from(
    dasher_private.canonical_jsonb_bytes_v1(v_body), 'UTF8'
  );
  IF pg_catalog.convert_to(v_compact_body, 'UTF8') <> p_canonical_bundle_bytes
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  BEGIN
    v_source_snapshot_id := (v_body->>'source_snapshot_id')::uuid;
    v_count := pg_catalog.jsonb_array_length(v_body->'entries');
  EXCEPTION WHEN data_exception THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END;
  SELECT payload.* INTO v_request_payload
  FROM dasher.agent_run_request_payloads AS payload
  WHERE payload.organization_id = v_run.organization_id
    AND payload.dashboard_id = v_run.dashboard_id
    AND payload.request_payload_id = v_run.request_payload_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  BEGIN
    v_request := pg_catalog.convert_from(
      v_request_payload.canonical_bytes, 'UTF8'
    )::jsonb;
    v_request_source_snapshot_id := (
      v_request->>'input_snapshot_id'
    )::uuid;
    v_catalog_snapshot_id := (
      v_request->'field_catalog'->>'catalog_snapshot_id'
    )::uuid;
    v_contract_set_id := (
      v_request->'metric_contract_set'->>'contract_set_id'
    )::uuid;
  EXCEPTION
    WHEN SQLSTATE '22021' OR SQLSTATE '22P02' OR SQLSTATE '22003' THEN
      RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END;
  v_request_semantic_sha := pg_catalog.sha256(
    pg_catalog.convert_to('dasher.agent-run-request.v1', 'UTF8')
    || pg_catalog.decode('00', 'hex')
    || pg_catalog.int4send(pg_catalog.octet_length(
      v_request_payload.canonical_bytes
    )) || v_request_payload.canonical_bytes
  );
  IF dasher_private.canonical_jsonb_bytes_v1(v_request)
      IS DISTINCT FROM v_request_payload.canonical_bytes
    OR v_request->>'run_request_id' <> v_run.run_request_id::text
    OR v_request->>'policy_revision' <> 'i64:' || v_run.policy_revision::text
    OR v_request->>'purpose' <> 'suggest'
    OR v_request->>'input_snapshot_id' <> v_source_snapshot_id::text
    OR v_request_payload.request_sha256 IS DISTINCT FROM pg_catalog.sha256(
      pg_catalog.convert_to('dasher.retained-payload-envelope.v1', 'UTF8')
      || pg_catalog.decode('00', 'hex')
      || pg_catalog.int4send(pg_catalog.octet_length(
        'agent-run-request-v1'
      )) || pg_catalog.convert_to('agent-run-request-v1', 'UTF8')
      || pg_catalog.int4send(pg_catalog.octet_length(
        v_request_payload.content_nonce
      )) || v_request_payload.content_nonce
      || pg_catalog.int4send(pg_catalog.octet_length(v_request_semantic_sha))
      || v_request_semantic_sha
    )
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;

  PERFORM pg_catalog.set_config(
    'dasher.run_lock_snapshot_id', v_source_snapshot_id::text, true
  );
  SELECT snapshot.* INTO v_source
  FROM dasher.source_snapshots AS snapshot
  WHERE snapshot.organization_id = v_run.organization_id
    AND snapshot.snapshot_id = v_source_snapshot_id
  FOR UPDATE;
  PERFORM pg_catalog.set_config('dasher.run_lock_snapshot_id', '', true);
  IF NOT FOUND
    OR v_source.content_sha256 <> pg_catalog.decode(
      v_request->>'input_sha256', 'hex'
    )
    OR v_source.canonical_bytes IS DISTINCT FROM
      dasher_private.canonical_jsonb_bytes_v1(v_request->'input_table')
    OR v_source.content_sha256 IS DISTINCT FROM pg_catalog.sha256(
      pg_catalog.convert_to('dasher.canonical-input-table.v1', 'UTF8')
      || pg_catalog.decode('00', 'hex')
      || pg_catalog.int4send(pg_catalog.octet_length(v_source.canonical_bytes))
      || v_source.canonical_bytes
    )
    OR v_source.observed_at IS NULL
    OR v_source.retrieved_at IS NULL
    OR v_source.created_at IS NULL
    OR v_source.observed_at > v_source.retrieved_at
    OR v_source.retrieved_at > v_source.created_at
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;

  SELECT catalog.* INTO v_catalog
  FROM dasher.field_catalog_snapshots AS catalog
  WHERE catalog.organization_id = v_run.organization_id
    AND catalog.dashboard_id = v_run.dashboard_id
    AND catalog.catalog_snapshot_id = v_catalog_snapshot_id
    AND catalog.input_snapshot_id = v_source.snapshot_id
    AND catalog.input_sha256 = v_source.content_sha256;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
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
  WHERE entry.organization_id = v_run.organization_id
    AND entry.dashboard_id = v_run.dashboard_id
    AND entry.catalog_snapshot_id = v_catalog.catalog_snapshot_id;
  IF v_rebuilt_field_catalog IS NULL
    OR v_rebuilt_field_catalog IS DISTINCT FROM v_request->'field_catalog'
    OR v_catalog.canonical_bytes IS DISTINCT FROM
      dasher_private.canonical_jsonb_bytes_v1(v_rebuilt_field_catalog)
    OR v_catalog.catalog_sha256 IS DISTINCT FROM pg_catalog.sha256(
      pg_catalog.convert_to('dasher.field-catalog-snapshot.v1', 'UTF8')
      || pg_catalog.decode('00', 'hex')
      || pg_catalog.int4send(pg_catalog.octet_length(v_catalog.canonical_bytes))
      || v_catalog.canonical_bytes
    )
    OR EXISTS (
      SELECT 1
      FROM dasher.field_catalog_entries AS entry
      JOIN LATERAL pg_catalog.jsonb_array_elements(
        v_rebuilt_field_catalog->'fields'
      ) AS field(value) ON field.value->>'field_id' = entry.field_id::text
      WHERE entry.organization_id = v_run.organization_id
        AND entry.dashboard_id = v_run.dashboard_id
        AND entry.catalog_snapshot_id = v_catalog.catalog_snapshot_id
        AND entry.entry_sha256 IS DISTINCT FROM pg_catalog.sha256(
          pg_catalog.convert_to('dasher.field-catalog-entry.v1', 'UTF8')
          || pg_catalog.decode('00', 'hex')
          || pg_catalog.int4send(pg_catalog.octet_length(
            dasher_private.canonical_jsonb_bytes_v1(field.value)
          )) || dasher_private.canonical_jsonb_bytes_v1(field.value)
        )
    )
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
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
    ) INTO v_rebuilt_contract_set
  FROM dasher.metric_contract_versions AS contract
  WHERE contract.organization_id = v_run.organization_id
    AND contract.dashboard_id = v_run.dashboard_id
    AND contract.catalog_snapshot_id = v_catalog.catalog_snapshot_id
    AND contract.contract_set_id = v_contract_set_id
    AND contract.review_state = 'reviewed'
  GROUP BY contract.contract_set_id, contract.catalog_snapshot_id;
  v_contract_set_sha := pg_catalog.sha256(
    pg_catalog.convert_to('dasher.metric-contract-set.v1', 'UTF8')
    || pg_catalog.decode('00', 'hex')
    || pg_catalog.int4send(pg_catalog.octet_length(
      dasher_private.canonical_jsonb_bytes_v1(v_rebuilt_contract_set)
    )) || dasher_private.canonical_jsonb_bytes_v1(v_rebuilt_contract_set)
  );
  IF v_rebuilt_contract_set IS NULL
    OR v_rebuilt_contract_set IS DISTINCT FROM
      v_request->'metric_contract_set'
    OR EXISTS (
      SELECT 1
      FROM dasher.metric_contract_versions AS contract
      JOIN LATERAL pg_catalog.jsonb_array_elements(
        v_rebuilt_contract_set->'contracts'
      ) AS member(value) ON member.value->>'contract_id' =
          contract.contract_id::text
        AND member.value->>'version' =
          'i64:' || contract.contract_version::text
      WHERE contract.organization_id = v_run.organization_id
        AND contract.dashboard_id = v_run.dashboard_id
        AND contract.catalog_snapshot_id = v_catalog.catalog_snapshot_id
        AND contract.contract_set_id = v_contract_set_id
        AND (
          contract.contract_set_sha256 IS DISTINCT FROM v_contract_set_sha
          OR contract.contract_sha256 IS DISTINCT FROM pg_catalog.sha256(
            pg_catalog.convert_to(
              'dasher.metric-contract-version.v1', 'UTF8'
            ) || pg_catalog.decode('00', 'hex')
            || pg_catalog.int4send(pg_catalog.octet_length(
              dasher_private.canonical_jsonb_bytes_v1(member.value)
            )) || dasher_private.canonical_jsonb_bytes_v1(member.value)
          )
        )
    )
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  BEGIN
    IF v_count NOT BETWEEN 1 AND 256
      OR v_source_snapshot_id <> v_request_source_snapshot_id
      OR EXISTS (
      SELECT 1
      FROM pg_catalog.jsonb_array_elements(v_body->'entries')
        WITH ORDINALITY AS entry(value, ordinal)
      WHERE pg_catalog.jsonb_typeof(entry.value) <> 'object'
        OR (SELECT pg_catalog.count(*)
            FROM pg_catalog.jsonb_object_keys(entry.value)) <> 6
        OR NOT entry.value ?& ARRAY[
          'evidence_id','evidence_sha256','source_snapshot_id','source_sha256',
          'freshness','observed_at'
        ]
        OR entry.value->>'freshness' NOT IN ('current','stale')
        OR (entry.value->>'source_snapshot_id')::uuid <> v_source_snapshot_id
        OR pg_catalog.octet_length(pg_catalog.decode(
          entry.value->>'evidence_sha256', 'hex'
        )) <> 32
        OR pg_catalog.octet_length(pg_catalog.decode(
          entry.value->>'source_sha256', 'hex'
        )) <> 32
        OR entry.value->>'observed_at' <> pg_catalog.to_char(
          (entry.value->>'observed_at')::timestamptz AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        )
        OR EXISTS (
          SELECT 1
          FROM pg_catalog.jsonb_array_elements(v_body->'entries')
            WITH ORDINALITY AS prior(value, ordinal)
          WHERE prior.ordinal = entry.ordinal - 1
            AND pg_catalog.uuid_send((prior.value->>'evidence_id')::uuid)
              >= pg_catalog.uuid_send((entry.value->>'evidence_id')::uuid)
        )
    )
    OR EXISTS (
      WITH expected(evidence_id) AS (
        SELECT pg_catalog.unnest(field.lineage_evidence_ids)
        FROM dasher.field_catalog_entries AS field
        WHERE field.organization_id = v_run.organization_id
          AND field.dashboard_id = v_run.dashboard_id
          AND field.catalog_snapshot_id = v_catalog_snapshot_id
        UNION
        SELECT pg_catalog.unnest(contract.lineage_evidence_ids)
        FROM dasher.metric_contract_versions AS contract
        WHERE contract.organization_id = v_run.organization_id
          AND contract.dashboard_id = v_run.dashboard_id
          AND contract.catalog_snapshot_id = v_catalog_snapshot_id
          AND contract.contract_set_id = v_contract_set_id
      ), actual(evidence_id) AS (
        SELECT (entry.value->>'evidence_id')::uuid
        FROM pg_catalog.jsonb_array_elements(v_body->'entries') AS entry(value)
      )
      (SELECT evidence_id FROM expected
       EXCEPT SELECT evidence_id FROM actual)
      UNION ALL
      (SELECT evidence_id FROM actual
       EXCEPT SELECT evidence_id FROM expected)
      )
    THEN
      RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
    END IF;
  EXCEPTION
    WHEN data_exception THEN
      RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END;
  FOR v_entry IN
    SELECT entry.value
    FROM pg_catalog.jsonb_array_elements(v_body->'entries') AS entry(value)
    ORDER BY pg_catalog.uuid_send((entry.value->>'evidence_id')::uuid)
  LOOP
    PERFORM pg_catalog.set_config(
      'dasher.run_lock_evidence_id',
      (v_entry->>'evidence_id')::uuid::text, true
    );
    SELECT evidence.* INTO v_locked_evidence
    FROM dasher.evidence_records AS evidence
    WHERE evidence.organization_id = v_run.organization_id
      AND evidence.evidence_id = (v_entry->>'evidence_id')::uuid
    FOR UPDATE;
    IF NOT FOUND
      OR v_locked_evidence.snapshot_id <>
        (v_entry->>'source_snapshot_id')::uuid
      OR v_locked_evidence.content_sha256 <> pg_catalog.decode(
        v_entry->>'evidence_sha256', 'hex'
      )
      OR v_locked_evidence.observed_at <>
        (v_entry->>'observed_at')::timestamptz
      OR v_source.content_sha256 <> pg_catalog.decode(
        v_entry->>'source_sha256', 'hex'
      )
    THEN
      RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
    END IF;
  END LOOP;
  PERFORM pg_catalog.set_config('dasher.run_lock_evidence_id', '', true);
  v_sha := pg_catalog.sha256(
    pg_catalog.convert_to('dasher.common-evidence-bundle.v1', 'UTF8')
    || pg_catalog.decode('00', 'hex')
    || pg_catalog.int4send(pg_catalog.octet_length(p_canonical_bundle_bytes))
    || p_canonical_bundle_bytes
  );
  SELECT bundle.* INTO v_existing
  FROM dasher.candidate_comparison_bundles AS bundle
  WHERE bundle.organization_id = v_run.organization_id
    AND bundle.dashboard_id = v_run.dashboard_id AND bundle.run_id = v_run.run_id;
  IF FOUND THEN
    IF v_existing.bundle_id <> p_bundle_id OR v_existing.bundle_sha256 <> v_sha THEN
      RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
    END IF;
    RETURN ROW(
      ROW(v_run.run_id, v_run.run_revision, v_run.state,
        v_run.current_event_sequence, v_run.current_event_sha256,
        v_run.lease_epoch)::dasher_run_api.run_mutation_result,
      p_bundle_id, v_sha
    )::dasher_run_api.content_commit_result;
  END IF;
  INSERT INTO dasher.candidate_comparison_bundles (
    organization_id, dashboard_id, run_id, bundle_id, source_snapshot_id,
    evidence_count, bundle_sha256, canonical_bytes, created_at
  ) VALUES (
    v_run.organization_id, v_run.dashboard_id, v_run.run_id, p_bundle_id,
    v_source_snapshot_id, v_count, v_sha, p_canonical_bundle_bytes,
    pg_catalog.statement_timestamp()
  );
  INSERT INTO dasher.candidate_comparison_bundle_evidence (
    organization_id, dashboard_id, run_id, bundle_id, evidence_id,
    source_snapshot_id, evidence_sha256, source_sha256, freshness, observed_at
  )
  SELECT v_run.organization_id, v_run.dashboard_id, v_run.run_id, p_bundle_id,
    (entry.value->>'evidence_id')::uuid,
    (entry.value->>'source_snapshot_id')::uuid,
    pg_catalog.decode(entry.value->>'evidence_sha256', 'hex'),
    pg_catalog.decode(entry.value->>'source_sha256', 'hex'),
    entry.value->>'freshness',
    (entry.value->>'observed_at')::timestamptz
  FROM pg_catalog.jsonb_array_elements(v_body->'entries') WITH ORDINALITY
    AS entry(value, ordinal)
  JOIN dasher.evidence_records AS evidence
    ON evidence.organization_id = v_run.organization_id
   AND evidence.evidence_id = (entry.value->>'evidence_id')::uuid
   AND evidence.snapshot_id = (entry.value->>'source_snapshot_id')::uuid
   AND evidence.content_sha256 = pg_catalog.decode(
     entry.value->>'evidence_sha256', 'hex'
   )
   AND evidence.observed_at = (entry.value->>'observed_at')::timestamptz
  JOIN dasher.source_snapshots AS snapshot
    ON snapshot.organization_id = evidence.organization_id
   AND snapshot.snapshot_id = evidence.snapshot_id
   AND snapshot.content_sha256 = pg_catalog.decode(
     entry.value->>'source_sha256', 'hex'
   )
   AND snapshot.snapshot_id = v_source_snapshot_id
  ORDER BY entry.ordinal;
  IF (
    SELECT pg_catalog.count(*)
    FROM dasher.candidate_comparison_bundle_evidence AS member
    WHERE member.organization_id = v_run.organization_id
      AND member.dashboard_id = v_run.dashboard_id AND member.run_id = v_run.run_id
      AND member.bundle_id = p_bundle_id
  ) <> v_count THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  v_mutation := dasher_private.append_agent_run_event_v1(
    v_run.run_id, dasher_private.uuid_v8_from_sha256_v1(pg_catalog.convert_to(pg_catalog.clock_timestamp()::text || '|' || pg_catalog.txid_current()::text || '|' || pg_catalog.random()::text, 'UTF8')), 'common_bundle_committed',
    pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'bundle_id', p_bundle_id::text,
      'bundle_sha256', pg_catalog.encode(v_sha, 'hex')
    )::text, 'UTF8')
  );
  RETURN ROW(v_mutation, p_bundle_id, v_sha)::dasher_run_api.content_commit_result;
END
$function$;

CREATE OR REPLACE FUNCTION dasher_run_api.reserve_agent_run_attempt(
  p_run_id uuid,
  p_lease_epoch bigint,
  p_attempt_token bytea,
  p_attempt_id uuid,
  p_partition text,
  p_attempt_kind text,
  p_reserved_vector dasher_run_api.attempt_resource_vector,
  p_canonical_request_bytes bytea
)
RETURNS dasher_run_api.attempt_reservation_result
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_run dasher.agent_runs%ROWTYPE;
  v_policy dasher.agent_run_policy_revisions%ROWTYPE;
  v_run_request dasher.agent_run_request_payloads%ROWTYPE;
  v_bundle dasher.candidate_comparison_bundles%ROWTYPE;
  v_existing dasher.agent_run_attempts%ROWTYPE;
  v_existing_request_payload dasher.agent_run_attempt_payloads%ROWTYPE;
  v_retry_attempt dasher.agent_run_attempts%ROWTYPE;
  v_retry_request_payload dasher.agent_run_attempt_payloads%ROWTYPE;
  v_retry_result_payload dasher.agent_run_attempt_payloads%ROWTYPE;
  v_retry_result dasher.agent_recorded_results%ROWTYPE;
  v_request jsonb;
  v_prior_request jsonb;
  v_brief dasher.briefs%ROWTYPE;
  v_brief_body jsonb;
  v_candidate_target_count smallint;
  v_specialist_required boolean;
  v_candidate_slot smallint;
  v_retry_of_attempt_id uuid;
  v_expected_partition text;
  v_expected_vector dasher_run_api.attempt_resource_vector;
  v_nonterminal_count bigint;
  v_retry_count bigint;
  v_vector jsonb := pg_catalog.to_jsonb(p_reserved_vector);
  v_payload_id uuid := dasher_private.uuid_v8_from_sha256_v1(pg_catalog.convert_to(pg_catalog.clock_timestamp()::text || '|' || pg_catalog.txid_current()::text || '|' || pg_catalog.random()::text, 'UTF8'));
  v_nonce bytea := pg_catalog.uuid_send(dasher_private.uuid_v8_from_sha256_v1(pg_catalog.convert_to(pg_catalog.clock_timestamp()::text || '|' || pg_catalog.txid_current()::text || '|' || pg_catalog.random()::text, 'UTF8')))
    || pg_catalog.uuid_send(dasher_private.uuid_v8_from_sha256_v1(pg_catalog.convert_to(pg_catalog.clock_timestamp()::text || '|' || pg_catalog.txid_current()::text || '|' || pg_catalog.random()::text, 'UTF8')));
  v_request_semantic_sha bytea;
  v_prior_request_semantic_sha bytea;
  v_prior_result_semantic_sha bytea;
  v_payload_sha bytea;
  v_mutation dasher_run_api.run_mutation_result;
  v_field record;
BEGIN
  IF p_attempt_id IS NULL OR p_partition NOT IN ('generation', 'review')
    OR p_attempt_kind NOT IN ('planner', 'generator', 'specialist', 'repair', 'reviewer')
    OR p_canonical_request_bytes IS NULL
    OR pg_catalog.octet_length(p_canonical_request_bytes) NOT BETWEEN 1 AND 65536
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_each_text(v_vector)) <> 14
    OR EXISTS (
      SELECT 1 FROM pg_catalog.jsonb_each_text(v_vector) AS item
      WHERE item.value::bigint < 0
    )
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;

  BEGIN
    v_request := pg_catalog.convert_from(p_canonical_request_bytes, 'UTF8')::jsonb;
  EXCEPTION
    WHEN SQLSTATE '22021' OR SQLSTATE '22P02' THEN
      RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END;
  IF dasher_private.canonical_jsonb_bytes_v1(v_request)
      IS DISTINCT FROM p_canonical_request_bytes
    OR pg_catalog.jsonb_typeof(v_request) <> 'object'
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(v_request)) <> 21
    OR NOT v_request ?& ARRAY[
      'schema','attempt_id','attempt_kind','adapter_id','model_id',
      'policy_revision','price_book_revision','candidate_slot',
      'retry_of_attempt_id','input_sha256','common_bundle_sha256','brief_sha256',
      'specialist_result_id','specialist_result_sha256','candidate_set_sha256',
      'candidate_validation_set_sha256','candidate_claim_sets_sha256',
      'invalid_result_id','invalid_result_sha256','invalid_validation_sha256',
      'instructions_sha256'
    ]
    OR v_request->>'schema' <> 'attempt-request-v1'
    OR v_request->>'attempt_id' <> p_attempt_id::text
    OR v_request->>'attempt_kind' <> p_attempt_kind
    OR v_request->>'policy_revision' !~ '^i64:[1-9][0-9]*$'
    OR v_request->>'input_sha256' !~ '^[0-9a-f]{64}$'
    OR v_request->>'common_bundle_sha256' !~ '^[0-9a-f]{64}$'
    OR v_request->>'instructions_sha256' !~ '^[0-9a-f]{64}$'
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.unnest(ARRAY[
        'brief_sha256','specialist_result_sha256','candidate_set_sha256',
        'candidate_validation_set_sha256','candidate_claim_sets_sha256',
        'invalid_result_sha256','invalid_validation_sha256'
      ]) AS key_name
      WHERE v_request->key_name <> 'null'::jsonb
        AND (
          pg_catalog.jsonb_typeof(v_request->key_name) <> 'string'
          OR v_request->>key_name !~ '^[0-9a-f]{64}$'
        )
    )
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.unnest(ARRAY[
        'specialist_result_id','invalid_result_id'
      ]) AS key_name
      WHERE v_request->key_name <> 'null'::jsonb
        AND (
          pg_catalog.jsonb_typeof(v_request->key_name) <> 'string'
          OR v_request->>key_name !~
            '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        )
    )
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;

  v_expected_partition := CASE WHEN p_attempt_kind = 'reviewer'
    THEN 'review' ELSE 'generation' END;
  v_expected_vector := CASE p_attempt_kind
    WHEN 'planner' THEN ROW(
      1,0,0,0,0,4000,2000,2000,4000,2000,6000,9000,8000,16000
    )::dasher_run_api.attempt_resource_vector
    WHEN 'generator' THEN ROW(
      1,1,0,0,0,6000,3000,3000,6000,3000,9000,9000,8000,24000
    )::dasher_run_api.attempt_resource_vector
    WHEN 'specialist' THEN ROW(
      1,0,1,0,0,4000,1000,1000,4000,1000,5000,9000,8000,12000
    )::dasher_run_api.attempt_resource_vector
    WHEN 'repair' THEN ROW(
      1,1,0,0,1,6000,2000,2000,6000,2000,8000,9000,8000,20000
    )::dasher_run_api.attempt_resource_vector
    ELSE ROW(
      1,0,0,1,0,4000,2000,2000,4000,2000,6000,9000,8000,16000
    )::dasher_run_api.attempt_resource_vector
  END;
  IF p_partition <> v_expected_partition
    OR p_reserved_vector IS DISTINCT FROM v_expected_vector
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;

  IF p_attempt_kind = 'generator' THEN
    IF pg_catalog.jsonb_typeof(v_request->'candidate_slot') <> 'string'
      OR v_request->>'candidate_slot' NOT IN ('i64:1', 'i64:2')
    THEN
      RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
    END IF;
    v_candidate_slot := pg_catalog.substring(
      v_request->>'candidate_slot', 5
    )::smallint;
  ELSIF v_request->'candidate_slot' <> 'null'::jsonb THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;

  IF v_request->'retry_of_attempt_id' <> 'null'::jsonb THEN
    IF pg_catalog.jsonb_typeof(v_request->'retry_of_attempt_id') <> 'string'
      OR p_attempt_kind NOT IN ('planner', 'generator')
    THEN
      RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
    END IF;
    BEGIN
      v_retry_of_attempt_id := (v_request->>'retry_of_attempt_id')::uuid;
    EXCEPTION WHEN SQLSTATE '22P02' THEN
      RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
    END;
  END IF;

  PERFORM dasher_private.initialize_run_operator_context_v1(p_run_id, 'reserve');
  PERFORM dasher_private.reauthorize_agent_run_v1(
    p_run_id, p_lease_epoch, p_attempt_token
  );
  SELECT run.* INTO STRICT v_run FROM dasher.agent_runs AS run
  WHERE run.organization_id = current_setting(
      'dasher.run_organization_id', true
    )::uuid AND run.run_id = p_run_id
  FOR UPDATE;
  SELECT policy.* INTO STRICT v_policy
  FROM dasher.agent_run_policy_revisions AS policy
  WHERE policy.policy_revision = v_run.policy_revision
  FOR UPDATE;
  SELECT payload.* INTO STRICT v_run_request
  FROM dasher.agent_run_request_payloads AS payload
  WHERE payload.organization_id = v_run.organization_id
    AND payload.dashboard_id = v_run.dashboard_id
    AND payload.request_payload_id = v_run.request_payload_id;
  SELECT bundle.* INTO v_bundle
  FROM dasher.candidate_comparison_bundles AS bundle
  WHERE bundle.organization_id = v_run.organization_id
    AND bundle.dashboard_id = v_run.dashboard_id
    AND bundle.run_id = v_run.run_id
    AND bundle.bundle_sha256 = pg_catalog.decode(
      v_request->>'common_bundle_sha256', 'hex'
    )
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  IF p_attempt_kind <> 'planner' THEN
    SELECT brief.* INTO v_brief
    FROM dasher.briefs AS brief
    WHERE brief.organization_id = v_run.organization_id
      AND brief.dashboard_id = v_run.dashboard_id
      AND brief.run_id = v_run.run_id
      AND brief.brief_sha256 = pg_catalog.decode(
        v_request->>'brief_sha256', 'hex'
      );
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
    END IF;
    BEGIN
      v_brief_body := pg_catalog.convert_from(
        v_brief.canonical_bytes, 'UTF8'
      )::jsonb;
      v_candidate_target_count := pg_catalog.substr(
        v_brief_body->>'candidate_target_count', 5
      )::smallint;
      v_specialist_required := (
        v_brief_body->>'specialist_required'
      )::boolean;
    EXCEPTION
      WHEN SQLSTATE '22021' OR SQLSTATE '22P02' OR SQLSTATE '22003' THEN
        RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
    END;
    IF dasher_private.canonical_jsonb_bytes_v1(v_brief_body)
        IS DISTINCT FROM v_brief.canonical_bytes
      OR v_brief.brief_sha256 IS DISTINCT FROM pg_catalog.sha256(
        pg_catalog.convert_to('dasher.agent-brief.v1', 'UTF8')
        || pg_catalog.decode('00', 'hex')
        || pg_catalog.int4send(pg_catalog.octet_length(
          v_brief.canonical_bytes
        )) || v_brief.canonical_bytes
      )
      OR v_brief_body->>'schema' <> 'agent-brief-v1'
      OR v_brief_body->>'brief_id' <> v_brief.brief_id::text
      OR v_brief_body->>'bundle_id' <> v_brief.common_bundle_id::text
      OR v_candidate_target_count NOT BETWEEN 1 AND 2
      OR pg_catalog.jsonb_typeof(
        v_brief_body->'specialist_required'
      ) <> 'boolean'
    THEN
      RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
    END IF;
  END IF;
  v_request_semantic_sha := pg_catalog.sha256(
    pg_catalog.convert_to('dasher.attempt-request.v1', 'UTF8')
    || pg_catalog.decode('00', 'hex')
    || pg_catalog.int4send(pg_catalog.octet_length(p_canonical_request_bytes))
    || p_canonical_request_bytes
  );
  IF v_run.state NOT IN ('authorized', 'planning', 'generating', 'revising', 'validating')
    OR v_request->>'adapter_id' <> v_policy.adapter_id
    OR v_request->>'model_id' <> v_policy.model_id
    OR v_request->>'price_book_revision' <> v_policy.price_book_revision
    OR v_request->>'policy_revision' <> 'i64:' || v_run.policy_revision::text
    OR v_request->>'input_sha256' <> pg_catalog.convert_from(
      v_run_request.canonical_bytes, 'UTF8'
    )::jsonb->>'input_sha256'
    OR v_request->>'instructions_sha256' <> pg_catalog.encode(
      CASE p_attempt_kind
        WHEN 'planner' THEN v_policy.planner_instructions_sha256
        WHEN 'generator' THEN v_policy.generator_instructions_sha256
        WHEN 'specialist' THEN v_policy.specialist_instructions_sha256
        WHEN 'repair' THEN v_policy.repair_instructions_sha256
        ELSE v_policy.reviewer_instructions_sha256
      END, 'hex'
    )
    OR NOT EXISTS (
      SELECT 1
      FROM dasher.candidate_comparison_bundles AS bundle
      WHERE bundle.organization_id = v_run.organization_id
        AND bundle.dashboard_id = v_run.dashboard_id
        AND bundle.run_id = v_run.run_id
        AND bundle.bundle_sha256 = pg_catalog.decode(
          v_request->>'common_bundle_sha256', 'hex'
        )
    )
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  IF (p_attempt_kind = 'planner' AND EXISTS (
      SELECT 1
      FROM pg_catalog.unnest(ARRAY[
        'brief_sha256','specialist_result_id','specialist_result_sha256',
        'candidate_set_sha256','candidate_validation_set_sha256',
        'candidate_claim_sets_sha256','invalid_result_id',
        'invalid_result_sha256','invalid_validation_sha256'
      ]) AS key_name
      WHERE v_request->key_name <> 'null'::jsonb
    ))
    OR (p_attempt_kind = 'specialist' AND (
      v_request->'brief_sha256' = 'null'::jsonb
      OR NOT v_specialist_required
      OR EXISTS (
        SELECT 1
        FROM pg_catalog.unnest(ARRAY[
          'specialist_result_id','specialist_result_sha256',
          'candidate_set_sha256','candidate_validation_set_sha256',
          'candidate_claim_sets_sha256','invalid_result_id',
          'invalid_result_sha256','invalid_validation_sha256'
        ]) AS key_name
        WHERE v_request->key_name <> 'null'::jsonb
      )
    ))
    OR (p_attempt_kind = 'generator' AND (
      v_request->'brief_sha256' = 'null'::jsonb
      OR v_candidate_slot NOT BETWEEN 1 AND v_candidate_target_count
      OR (v_request->'specialist_result_id' = 'null'::jsonb)
        <> (v_request->'specialist_result_sha256' = 'null'::jsonb)
      OR (v_request->'specialist_result_id' <> 'null'::jsonb)
        <> v_specialist_required
      OR EXISTS (
        SELECT 1
        FROM pg_catalog.unnest(ARRAY[
          'candidate_set_sha256','candidate_validation_set_sha256',
          'candidate_claim_sets_sha256','invalid_result_id',
          'invalid_result_sha256','invalid_validation_sha256'
        ]) AS key_name
        WHERE v_request->key_name <> 'null'::jsonb
      )
    ))
    OR (p_attempt_kind = 'repair' AND (
      v_request->'brief_sha256' = 'null'::jsonb
      OR (v_request->'specialist_result_id' = 'null'::jsonb)
        <> (v_request->'specialist_result_sha256' = 'null'::jsonb)
      OR (v_request->'specialist_result_id' <> 'null'::jsonb)
        <> v_specialist_required
      OR v_request->'invalid_result_id' = 'null'::jsonb
      OR v_request->'invalid_result_sha256' = 'null'::jsonb
      OR v_request->'invalid_validation_sha256' = 'null'::jsonb
      OR EXISTS (
        SELECT 1
        FROM pg_catalog.unnest(ARRAY[
          'candidate_set_sha256','candidate_validation_set_sha256',
          'candidate_claim_sets_sha256'
        ]) AS key_name
        WHERE v_request->key_name <> 'null'::jsonb
      )
    ))
    OR (p_attempt_kind = 'reviewer' AND (
      v_request->'brief_sha256' = 'null'::jsonb
      OR v_request->'candidate_set_sha256' = 'null'::jsonb
      OR v_request->'candidate_validation_set_sha256' = 'null'::jsonb
      OR v_request->'candidate_claim_sets_sha256' = 'null'::jsonb
      OR EXISTS (
        SELECT 1
        FROM pg_catalog.unnest(ARRAY[
          'specialist_result_id','specialist_result_sha256',
          'invalid_result_id','invalid_result_sha256',
          'invalid_validation_sha256'
        ]) AS key_name
        WHERE v_request->key_name <> 'null'::jsonb
      )
    ))
    OR (p_attempt_kind <> 'planner' AND NOT EXISTS (
      SELECT 1
      FROM dasher.briefs AS brief
      WHERE brief.organization_id = v_run.organization_id
        AND brief.dashboard_id = v_run.dashboard_id
        AND brief.run_id = v_run.run_id
        AND brief.brief_sha256 = pg_catalog.decode(
          v_request->>'brief_sha256', 'hex'
        )
    ))
    OR (v_request->'specialist_result_id' <> 'null'::jsonb AND NOT EXISTS (
      SELECT 1
      FROM dasher.agent_recorded_results AS result
      JOIN dasher.agent_run_attempts AS attempt
        ON attempt.organization_id = result.organization_id
       AND attempt.dashboard_id = result.dashboard_id
       AND attempt.run_id = result.run_id
       AND attempt.attempt_id = result.attempt_id
      WHERE result.organization_id = v_run.organization_id
        AND result.dashboard_id = v_run.dashboard_id
        AND result.run_id = v_run.run_id
        AND result.result_id = (v_request->>'specialist_result_id')::uuid
        AND result.result_sha256 = pg_catalog.decode(
          v_request->>'specialist_result_sha256', 'hex'
        )
        AND result.result_kind = 'specialist_output'
        AND attempt.attempt_kind = 'specialist'
        AND attempt.state = 'succeeded'
        AND 1 = (
          SELECT pg_catalog.count(*)
          FROM dasher.agent_run_attempts AS sole_specialist
          JOIN dasher.agent_recorded_results AS sole_result
            ON sole_result.organization_id = sole_specialist.organization_id
           AND sole_result.dashboard_id = sole_specialist.dashboard_id
           AND sole_result.run_id = sole_specialist.run_id
           AND sole_result.attempt_id = sole_specialist.attempt_id
          WHERE sole_specialist.organization_id = v_run.organization_id
            AND sole_specialist.dashboard_id = v_run.dashboard_id
            AND sole_specialist.run_id = v_run.run_id
            AND sole_specialist.attempt_kind = 'specialist'
            AND sole_specialist.state = 'succeeded'
            AND sole_result.result_kind = 'specialist_output'
        )
    ))
    OR (p_attempt_kind = 'reviewer' AND (
      v_run.candidate_set_sha256 IS DISTINCT FROM pg_catalog.decode(
        v_request->>'candidate_set_sha256', 'hex'
      )
      OR (SELECT pg_catalog.count(*)
          FROM dasher.agent_candidates AS candidate
          WHERE candidate.organization_id = v_run.organization_id
            AND candidate.dashboard_id = v_run.dashboard_id
            AND candidate.run_id = v_run.run_id) <> v_candidate_target_count
      OR EXISTS (
        SELECT 1
        FROM dasher.agent_candidates AS candidate
        LEFT JOIN dasher.agent_validation_findings AS finding
          ON finding.organization_id = candidate.organization_id
         AND finding.dashboard_id = candidate.dashboard_id
         AND finding.run_id = candidate.run_id
         AND finding.candidate_id = candidate.candidate_id
        WHERE candidate.organization_id = v_run.organization_id
          AND candidate.dashboard_id = v_run.dashboard_id
          AND candidate.run_id = v_run.run_id
          AND (finding.candidate_id IS NULL
            OR candidate.manifest_sha256 IS NOT NULL
            OR finding.validation_state <> candidate.validation_state)
      )
      OR pg_catalog.decode(
        v_request->>'candidate_validation_set_sha256', 'hex'
      ) IS DISTINCT FROM pg_catalog.sha256(
        pg_catalog.convert_to('dasher.candidate-validation-set.v1', 'UTF8')
        || pg_catalog.decode('00', 'hex')
        || v_run.candidate_set_sha256
        || pg_catalog.int8send((
          SELECT pg_catalog.count(*)
          FROM dasher.agent_candidates AS candidate
          WHERE candidate.organization_id = v_run.organization_id
            AND candidate.dashboard_id = v_run.dashboard_id
            AND candidate.run_id = v_run.run_id
        ))
        || COALESCE((
          SELECT pg_catalog.string_agg(
            pg_catalog.uuid_send(candidate.candidate_id)
              || finding.findings_sha256,
            ''::bytea ORDER BY pg_catalog.uuid_send(candidate.candidate_id)
          )
          FROM dasher.agent_candidates AS candidate
          JOIN dasher.agent_validation_findings AS finding
            ON finding.organization_id = candidate.organization_id
           AND finding.dashboard_id = candidate.dashboard_id
           AND finding.run_id = candidate.run_id
           AND finding.candidate_id = candidate.candidate_id
          WHERE candidate.organization_id = v_run.organization_id
            AND candidate.dashboard_id = v_run.dashboard_id
            AND candidate.run_id = v_run.run_id
        ), ''::bytea)
      )
      OR pg_catalog.decode(
        v_request->>'candidate_claim_sets_sha256', 'hex'
      ) IS DISTINCT FROM pg_catalog.sha256(
        pg_catalog.convert_to('dasher.candidate-claim-sets.v1', 'UTF8')
        || pg_catalog.decode('00', 'hex')
        || v_run.candidate_set_sha256
        || pg_catalog.int8send((
          SELECT pg_catalog.count(*)
          FROM dasher.agent_candidates AS candidate
          WHERE candidate.organization_id = v_run.organization_id
            AND candidate.dashboard_id = v_run.dashboard_id
            AND candidate.run_id = v_run.run_id
        ))
        || COALESCE((
          SELECT pg_catalog.string_agg(
            pg_catalog.uuid_send(candidate.candidate_id)
              || candidate.material_claim_set_sha256,
            ''::bytea ORDER BY pg_catalog.uuid_send(candidate.candidate_id)
          )
          FROM dasher.agent_candidates AS candidate
          WHERE candidate.organization_id = v_run.organization_id
            AND candidate.dashboard_id = v_run.dashboard_id
            AND candidate.run_id = v_run.run_id
        ), ''::bytea)
      )
    ))
    OR (p_attempt_kind = 'repair' AND NOT EXISTS (
      SELECT 1
      FROM dasher.agent_recorded_results AS result
      JOIN dasher.agent_run_attempts AS invalid_attempt
        ON invalid_attempt.organization_id = result.organization_id
       AND invalid_attempt.dashboard_id = result.dashboard_id
       AND invalid_attempt.run_id = result.run_id
       AND invalid_attempt.attempt_id = result.attempt_id
      WHERE result.organization_id = v_run.organization_id
        AND result.dashboard_id = v_run.dashboard_id
        AND result.run_id = v_run.run_id
        AND result.result_id = (v_request->>'invalid_result_id')::uuid
        AND result.result_sha256 = pg_catalog.decode(
          v_request->>'invalid_result_sha256', 'hex'
        )
        AND result.result_kind = 'candidate_invalid'
        AND invalid_attempt.attempt_kind = 'generator'
        AND invalid_attempt.candidate_slot BETWEEN 1 AND
          v_candidate_target_count
        AND invalid_attempt.state = 'succeeded'
        AND pg_catalog.convert_from(
          result.canonical_bytes, 'UTF8'
        )::jsonb#>>'{result,precommit_validation,state}' = 'invalid'
        AND pg_catalog.sha256(
          pg_catalog.convert_to(
            'dasher.precommit-dashboard-validation.v1', 'UTF8'
          ) || pg_catalog.decode('00', 'hex')
          || pg_catalog.int4send(pg_catalog.octet_length(
            dasher_private.canonical_jsonb_bytes_v1(
              pg_catalog.convert_from(
                result.canonical_bytes, 'UTF8'
              )::jsonb#>'{result,precommit_validation}'
            )
          ))
          || dasher_private.canonical_jsonb_bytes_v1(
            pg_catalog.convert_from(
              result.canonical_bytes, 'UTF8'
            )::jsonb#>'{result,precommit_validation}'
          )
        ) = pg_catalog.decode(
          v_request->>'invalid_validation_sha256', 'hex'
        )
    ))
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  SELECT attempt.* INTO v_existing FROM dasher.agent_run_attempts AS attempt
  WHERE attempt.organization_id = v_run.organization_id
    AND attempt.dashboard_id = v_run.dashboard_id
    AND attempt.run_id = v_run.run_id AND attempt.attempt_id = p_attempt_id;
  IF FOUND THEN
    SELECT payload.* INTO v_existing_request_payload
    FROM dasher.agent_run_attempt_payloads AS payload
    WHERE payload.organization_id = v_existing.organization_id
      AND payload.dashboard_id = v_existing.dashboard_id
      AND payload.run_id = v_existing.run_id
      AND payload.attempt_id = v_existing.attempt_id
      AND payload.payload_kind = 'request'
      AND payload.payload_id = v_existing.request_payload_id;
    IF v_existing.lease_epoch <> p_lease_epoch
      OR v_existing.partition <> p_partition
      OR v_existing.attempt_kind <> p_attempt_kind
      OR v_existing.candidate_slot IS DISTINCT FROM v_candidate_slot
      OR v_existing.retry_of_attempt_id IS DISTINCT FROM v_retry_of_attempt_id
      OR v_existing.reserved_vector IS DISTINCT FROM p_reserved_vector
      OR NOT FOUND
      OR v_existing_request_payload.canonical_bytes
        IS DISTINCT FROM p_canonical_request_bytes
      OR v_existing_request_payload.payload_sha256 IS DISTINCT FROM
        pg_catalog.sha256(
          pg_catalog.convert_to('dasher.retained-payload-envelope.v1', 'UTF8')
          || pg_catalog.decode('00', 'hex')
          || pg_catalog.int4send(pg_catalog.octet_length('attempt-request-v1'))
          || pg_catalog.convert_to('attempt-request-v1', 'UTF8')
          || pg_catalog.int4send(pg_catalog.octet_length(
            v_existing_request_payload.content_nonce
          ))
          || v_existing_request_payload.content_nonce
          || pg_catalog.int4send(pg_catalog.octet_length(
            v_request_semantic_sha
          ))
          || v_request_semantic_sha
        )
      OR NOT EXISTS (
        SELECT 1
        FROM dasher.agent_run_events AS event
        WHERE event.organization_id = v_existing.organization_id
          AND event.dashboard_id = v_existing.dashboard_id
          AND event.run_id = v_existing.run_id
          AND event.event_kind = 'attempt_reserved'
          AND event.occurred_at = v_existing.reserved_at
      )
    THEN
      RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
    END IF;
    RETURN ROW(
      ROW(v_run.run_id, v_run.run_revision, v_run.state,
        v_run.current_event_sequence, v_run.current_event_sha256,
        v_run.lease_epoch)::dasher_run_api.run_mutation_result,
      p_attempt_id, p_reserved_vector
    )::dasher_run_api.attempt_reservation_result;
  END IF;

  SELECT pg_catalog.count(*) INTO v_nonterminal_count
  FROM dasher.agent_run_attempts AS attempt
  WHERE attempt.organization_id = v_run.organization_id
    AND attempt.dashboard_id = v_run.dashboard_id
    AND attempt.run_id = v_run.run_id
    AND attempt.state IN (
      'reserved_pre_dispatch', 'dispatch_ready', 'dispatch_started'
    );
  SELECT pg_catalog.count(*) INTO v_retry_count
  FROM dasher.agent_run_attempts AS attempt
  WHERE attempt.organization_id = v_run.organization_id
    AND attempt.dashboard_id = v_run.dashboard_id
    AND attempt.run_id = v_run.run_id
    AND attempt.retry_of_attempt_id IS NOT NULL;

  IF v_retry_of_attempt_id IS NOT NULL THEN
    SELECT attempt.* INTO v_retry_attempt
    FROM dasher.agent_run_attempts AS attempt
    WHERE attempt.organization_id = v_run.organization_id
      AND attempt.dashboard_id = v_run.dashboard_id
      AND attempt.run_id = v_run.run_id
      AND attempt.attempt_id = v_retry_of_attempt_id;
    IF NOT FOUND OR v_retry_count <> 0
      OR v_retry_attempt.state <> 'failed_charged'
      OR v_retry_attempt.attempt_kind <> p_attempt_kind
      OR v_retry_attempt.candidate_slot IS DISTINCT FROM v_candidate_slot
      OR v_retry_attempt.reserved_vector IS DISTINCT FROM v_expected_vector
      OR v_retry_attempt.result_payload_id IS NULL
      OR EXISTS (
        SELECT 1 FROM dasher.agent_run_attempts AS later
        WHERE later.organization_id = v_run.organization_id
          AND later.dashboard_id = v_run.dashboard_id
          AND later.run_id = v_run.run_id
          AND later.reserved_at > v_retry_attempt.reserved_at
          AND later.attempt_id <> p_attempt_id
          AND NOT (
            p_attempt_kind = 'generator'
            AND later.attempt_kind = 'generator'
            AND later.candidate_slot > v_candidate_slot
            AND later.state = 'reserved_pre_dispatch'
            AND later.dispatch_ready_at IS NULL
          )
      )
      OR NOT EXISTS (
        SELECT 1
        FROM dasher.agent_run_attempt_payloads AS result_payload
        WHERE result_payload.organization_id = v_run.organization_id
          AND result_payload.dashboard_id = v_run.dashboard_id
          AND result_payload.run_id = v_run.run_id
          AND result_payload.attempt_id = v_retry_attempt.attempt_id
          AND result_payload.payload_kind = 'result'
          AND result_payload.payload_id = v_retry_attempt.result_payload_id
          AND pg_catalog.convert_from(
            result_payload.canonical_bytes, 'UTF8'
          )::jsonb->>'result_kind' = 'failure'
          AND pg_catalog.convert_from(
            result_payload.canonical_bytes, 'UTF8'
          )::jsonb#>>'{result,retryable}' = 'true'
      )
    THEN
      RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
    END IF;
    SELECT request_payload.* INTO STRICT v_retry_request_payload
    FROM dasher.agent_run_attempt_payloads AS request_payload
    WHERE request_payload.organization_id = v_run.organization_id
      AND request_payload.dashboard_id = v_run.dashboard_id
      AND request_payload.run_id = v_run.run_id
      AND request_payload.attempt_id = v_retry_attempt.attempt_id
      AND request_payload.payload_kind = 'request'
      AND request_payload.payload_id = v_retry_attempt.request_payload_id;
    BEGIN
      v_prior_request := pg_catalog.convert_from(
        v_retry_request_payload.canonical_bytes, 'UTF8'
      )::jsonb;
    EXCEPTION
      WHEN SQLSTATE '22021' OR SQLSTATE '22P02' THEN
        RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
    END;
    v_prior_request_semantic_sha := pg_catalog.sha256(
      pg_catalog.convert_to('dasher.attempt-request.v1', 'UTF8')
      || pg_catalog.decode('00', 'hex')
      || pg_catalog.int4send(pg_catalog.octet_length(
        v_retry_request_payload.canonical_bytes
      ))
      || v_retry_request_payload.canonical_bytes
    );
    SELECT result.* INTO STRICT v_retry_result
    FROM dasher.agent_recorded_results AS result
    WHERE result.organization_id = v_run.organization_id
      AND result.dashboard_id = v_run.dashboard_id
      AND result.run_id = v_run.run_id
      AND result.attempt_id = v_retry_attempt.attempt_id
      AND result.result_payload_id = v_retry_attempt.result_payload_id;
    SELECT result_payload.* INTO STRICT v_retry_result_payload
    FROM dasher.agent_run_attempt_payloads AS result_payload
    WHERE result_payload.organization_id = v_run.organization_id
      AND result_payload.dashboard_id = v_run.dashboard_id
      AND result_payload.run_id = v_run.run_id
      AND result_payload.attempt_id = v_retry_attempt.attempt_id
      AND result_payload.payload_kind = 'result'
      AND result_payload.payload_id = v_retry_attempt.result_payload_id;
    v_prior_result_semantic_sha := pg_catalog.sha256(
      pg_catalog.convert_to('dasher.recorded-result.v1', 'UTF8')
      || pg_catalog.decode('00', 'hex')
      || pg_catalog.int4send(pg_catalog.octet_length(
        v_retry_result_payload.canonical_bytes
      ))
      || v_retry_result_payload.canonical_bytes
    );
    IF dasher_private.canonical_jsonb_bytes_v1(v_prior_request)
        IS DISTINCT FROM v_retry_request_payload.canonical_bytes
      OR v_prior_request->>'schema' <> 'attempt-request-v1'
      OR v_prior_request->>'attempt_id' <> v_retry_attempt.attempt_id::text
      OR v_prior_request->'retry_of_attempt_id' <> 'null'::jsonb
      OR v_retry_request_payload.payload_sha256 IS DISTINCT FROM
        pg_catalog.sha256(
          pg_catalog.convert_to(
            'dasher.retained-payload-envelope.v1', 'UTF8'
          ) || pg_catalog.decode('00', 'hex')
          || pg_catalog.int4send(pg_catalog.octet_length(
            'attempt-request-v1'
          )) || pg_catalog.convert_to('attempt-request-v1', 'UTF8')
          || pg_catalog.int4send(pg_catalog.octet_length(
            v_retry_request_payload.content_nonce
          )) || v_retry_request_payload.content_nonce
          || pg_catalog.int4send(pg_catalog.octet_length(
            v_prior_request_semantic_sha
          )) || v_prior_request_semantic_sha
        )
      OR dasher_private.canonical_jsonb_bytes_v1(
        v_request - 'attempt_id' - 'retry_of_attempt_id'
      ) IS DISTINCT FROM dasher_private.canonical_jsonb_bytes_v1(
        v_prior_request - 'attempt_id' - 'retry_of_attempt_id'
      )
      OR v_retry_result.canonical_bytes IS DISTINCT FROM
        v_retry_result_payload.canonical_bytes
      OR v_retry_result.result_sha256 IS DISTINCT FROM
        v_prior_result_semantic_sha
      OR v_retry_result.result_kind <> 'failure'
      OR pg_catalog.convert_from(
        v_retry_result.canonical_bytes, 'UTF8'
      )::jsonb <> pg_catalog.jsonb_build_object(
        'schema', 'recorded-result-v1',
        'result_id', v_retry_result.result_id::text,
        'attempt_id', v_retry_attempt.attempt_id::text,
        'attempt_kind', v_retry_attempt.attempt_kind,
        'adapter_id', v_prior_request->>'adapter_id',
        'model_id', v_prior_request->>'model_id',
        'request_sha256', pg_catalog.encode(
          v_prior_request_semantic_sha, 'hex'
        ),
        'result_kind', 'failure',
        'result', pg_catalog.convert_from(
          v_retry_result.canonical_bytes, 'UTF8'
        )::jsonb->'result'
      )
      OR pg_catalog.convert_from(
        v_retry_result.canonical_bytes, 'UTF8'
      )::jsonb#>>'{result,retryable}' <> 'true'
      OR v_retry_result_payload.payload_sha256 IS DISTINCT FROM
        pg_catalog.sha256(
          pg_catalog.convert_to(
            'dasher.retained-payload-envelope.v1', 'UTF8'
          ) || pg_catalog.decode('00', 'hex')
          || pg_catalog.int4send(pg_catalog.octet_length(
            'recorded-result-v1'
          )) || pg_catalog.convert_to('recorded-result-v1', 'UTF8')
          || pg_catalog.int4send(pg_catalog.octet_length(
            v_retry_result_payload.content_nonce
          )) || v_retry_result_payload.content_nonce
          || pg_catalog.int4send(pg_catalog.octet_length(
            v_prior_result_semantic_sha
          )) || v_prior_result_semantic_sha
        )
      OR v_retry_result.result_head_sha256 IS DISTINCT FROM
        pg_catalog.sha256(
          pg_catalog.convert_to('dasher.replay-result-head.v1', 'UTF8')
          || pg_catalog.decode('00', 'hex')
          || pg_catalog.uuid_send(v_retry_result.run_id)
          || pg_catalog.int8send(v_retry_result.result_sequence)
          || CASE WHEN v_retry_result.prior_result_head_sha256 IS NULL
            THEN pg_catalog.decode('00', 'hex')
            ELSE pg_catalog.decode('01', 'hex')
              || v_retry_result.prior_result_head_sha256 END
          || pg_catalog.uuid_send(v_retry_result.result_id)
          || pg_catalog.int4send(pg_catalog.octet_length(
            v_retry_result.result_kind
          )) || pg_catalog.convert_to(v_retry_result.result_kind, 'UTF8')
          || v_retry_result.result_sha256
        )
      OR v_retry_result.result_sequence <> (
        SELECT pg_catalog.max(result.result_sequence)
        FROM dasher.agent_recorded_results AS result
        WHERE result.organization_id = v_run.organization_id
          AND result.dashboard_id = v_run.dashboard_id
          AND result.run_id = v_run.run_id
      )
    THEN
      RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
    END IF;
  ELSIF p_attempt_kind <> 'generator' AND v_nonterminal_count <> 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  ELSIF p_attempt_kind = 'generator' AND EXISTS (
    SELECT 1 FROM dasher.agent_run_attempts AS attempt
    WHERE attempt.organization_id = v_run.organization_id
      AND attempt.dashboard_id = v_run.dashboard_id
      AND attempt.run_id = v_run.run_id
      AND attempt.state IN ('dispatch_ready', 'dispatch_started')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;

  IF (p_attempt_kind = 'planner' AND (
      (v_retry_of_attempt_id IS NULL AND v_run.state <> 'authorized')
      OR (v_retry_of_attempt_id IS NOT NULL AND v_run.state <> 'planning')
      OR (v_retry_of_attempt_id IS NULL AND EXISTS (
        SELECT 1 FROM dasher.agent_run_attempts AS prior
        WHERE prior.organization_id = v_run.organization_id
          AND prior.dashboard_id = v_run.dashboard_id
          AND prior.run_id = v_run.run_id
      ))
    ))
    OR (p_attempt_kind IN ('specialist', 'generator')
      AND v_run.state NOT IN ('planning', 'generating'))
    OR (p_attempt_kind = 'repair' AND (
      v_run.state <> 'generating'
      OR NOT EXISTS (
        SELECT 1 FROM dasher.agent_recorded_results AS result
        WHERE result.organization_id = v_run.organization_id
          AND result.dashboard_id = v_run.dashboard_id
          AND result.run_id = v_run.run_id
          AND result.result_kind = 'candidate_invalid'
      )
    ))
    OR (p_attempt_kind = 'reviewer' AND (
      v_run.state <> 'validating' OR v_run.candidate_set_sha256 IS NULL
    ))
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  FOR v_field IN
    SELECT item.key AS vector_field, item.value::bigint AS units
    FROM pg_catalog.jsonb_each_text(v_vector) AS item
    ORDER BY item.key
  LOOP
    PERFORM 1 FROM dasher.agent_run_budget_counters AS counter
    WHERE counter.organization_id = v_run.organization_id
      AND counter.dashboard_id = v_run.dashboard_id
      AND counter.run_id = v_run.run_id
      AND counter.partition = p_partition
      AND counter.vector_field = v_field.vector_field
      AND counter.reserved_units::numeric
        - counter.released_units::numeric
        + v_field.units::numeric <= counter.limit_units::numeric;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_budget_exceeded';
    END IF;
  END LOOP;
  v_payload_sha := pg_catalog.sha256(
    pg_catalog.convert_to('dasher.retained-payload-envelope.v1', 'UTF8')
    || pg_catalog.decode('00', 'hex')
    || pg_catalog.int4send(pg_catalog.octet_length('attempt-request-v1'))
    || pg_catalog.convert_to('attempt-request-v1', 'UTF8')
    || pg_catalog.int4send(pg_catalog.octet_length(v_nonce))
    || v_nonce
    || pg_catalog.int4send(pg_catalog.octet_length(v_request_semantic_sha))
    || v_request_semantic_sha
  );
  INSERT INTO dasher.agent_run_attempt_payloads (
    organization_id, dashboard_id, run_id, attempt_id, payload_kind,
    payload_id, content_nonce, canonical_bytes, payload_sha256, created_at
  ) VALUES (
    v_run.organization_id, v_run.dashboard_id, v_run.run_id, p_attempt_id,
    'request', v_payload_id, v_nonce, p_canonical_request_bytes, v_payload_sha,
    pg_catalog.statement_timestamp()
  );
  INSERT INTO dasher.agent_run_attempts (
    organization_id, dashboard_id, run_id, attempt_id, lease_epoch, partition,
    attempt_kind, candidate_slot, retry_of_attempt_id, state,
    request_payload_id, result_payload_id, reserved_vector, actual_vector,
    used_vector, released_vector, outstanding_vector, reserved_at,
    dispatch_ready_at, dispatch_started_at, reconciled_at, terminal_reason_sha256
  ) VALUES (
    v_run.organization_id, v_run.dashboard_id, v_run.run_id, p_attempt_id,
    p_lease_epoch, p_partition, p_attempt_kind, v_candidate_slot,
    v_retry_of_attempt_id, 'reserved_pre_dispatch', v_payload_id, NULL,
    p_reserved_vector, NULL,
    ROW(0,0,0,0,0,0,0,0,0,0,0,0,0,0)::dasher_run_api.attempt_resource_vector,
    ROW(0,0,0,0,0,0,0,0,0,0,0,0,0,0)::dasher_run_api.attempt_resource_vector,
    p_reserved_vector, pg_catalog.statement_timestamp(), NULL, NULL, NULL, NULL
  );
  FOR v_field IN
    SELECT item.key AS vector_field, item.value::bigint AS units
    FROM pg_catalog.jsonb_each_text(v_vector) AS item
    ORDER BY item.key
  LOOP
    UPDATE dasher.agent_run_budget_counters AS counter
    SET reserved_units = counter.reserved_units + v_field.units,
      updated_at = pg_catalog.statement_timestamp()
    WHERE counter.organization_id = v_run.organization_id
      AND counter.dashboard_id = v_run.dashboard_id
      AND counter.run_id = v_run.run_id
      AND counter.partition = p_partition
      AND counter.vector_field = v_field.vector_field;
  END LOOP;
  IF p_attempt_kind = 'planner' THEN
    PERFORM pg_catalog.set_config('dasher.run_next_state', 'planning', true);
  ELSIF p_attempt_kind IN ('specialist', 'generator')
    AND v_run.state = 'planning'
  THEN
    PERFORM pg_catalog.set_config('dasher.run_next_state', 'generating', true);
  ELSIF p_attempt_kind = 'repair' THEN
    PERFORM pg_catalog.set_config('dasher.run_next_state', 'revising', true);
  END IF;
  v_mutation := dasher_private.append_agent_run_event_v1(
    v_run.run_id, dasher_private.uuid_v8_from_sha256_v1(pg_catalog.convert_to(pg_catalog.clock_timestamp()::text || '|' || pg_catalog.txid_current()::text || '|' || pg_catalog.random()::text, 'UTF8')), 'attempt_reserved',
    pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'attempt_id', p_attempt_id::text,
      'partition', p_partition,
      'attempt_kind', p_attempt_kind,
      'candidate_slot', CASE WHEN v_candidate_slot IS NULL THEN NULL
        ELSE 'i64:' || v_candidate_slot::text END,
      'retry_of_attempt_id', v_retry_of_attempt_id::text,
      'request_payload_id', v_payload_id::text,
      'request_sha256', pg_catalog.encode(v_request_semantic_sha, 'hex'),
      'reserved_vector', pg_catalog.to_jsonb(p_reserved_vector)
    )::text, 'UTF8')
  );
  RETURN ROW(v_mutation, p_attempt_id, p_reserved_vector)
    ::dasher_run_api.attempt_reservation_result;
END
$function$;

CREATE OR REPLACE FUNCTION dasher_run_api.reconcile_agent_run_attempt(
  p_run_id uuid,
  p_lease_epoch bigint,
  p_attempt_token bytea,
  p_attempt_id uuid,
  p_outcome text,
  p_actual_accounting_bytes bytea,
  p_result_sha256 bytea,
  p_canonical_recorded_result_bytes bytea
)
RETURNS dasher_run_api.attempt_accounting_result
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_run dasher.agent_runs%ROWTYPE;
  v_attempt dasher.agent_run_attempts%ROWTYPE;
  v_discovered_attempt dasher.agent_run_attempts%ROWTYPE;
  v_bundle dasher.candidate_comparison_bundles%ROWTYPE;
  v_bundle_members_before bytea;
  v_bundle_members_after bytea;
  v_policy dasher.agent_run_policy_revisions%ROWTYPE;
  v_accounting jsonb;
  v_accounting_text text;
  v_reconstructed_accounting text;
  v_accounting_keys text[];
  v_vector_json jsonb := '{}'::jsonb;
  v_key text;
  v_tagged_value text;
  v_decimal text;
  v_index integer;
  v_digit_start integer;
  v_octet integer;
  v_malformed boolean := false;
  v_indeterminate_reason text;
  v_actual dasher_run_api.attempt_resource_vector;
  v_zero dasher_run_api.attempt_resource_vector :=
    ROW(0,0,0,0,0,0,0,0,0,0,0,0,0,0)::dasher_run_api.attempt_resource_vector;
  v_payload_id uuid := dasher_private.uuid_v8_from_sha256_v1(pg_catalog.convert_to(pg_catalog.clock_timestamp()::text || '|' || pg_catalog.txid_current()::text || '|' || pg_catalog.random()::text, 'UTF8'));
  v_nonce bytea := pg_catalog.uuid_send(dasher_private.uuid_v8_from_sha256_v1(pg_catalog.convert_to(pg_catalog.clock_timestamp()::text || '|' || pg_catalog.txid_current()::text || '|' || pg_catalog.random()::text, 'UTF8')))
    || pg_catalog.uuid_send(dasher_private.uuid_v8_from_sha256_v1(pg_catalog.convert_to(pg_catalog.clock_timestamp()::text || '|' || pg_catalog.txid_current()::text || '|' || pg_catalog.random()::text, 'UTF8')));
  v_payload_sha bytea;
  v_result_semantic_sha bytea;
  v_result_head bytea;
  v_prior_head bytea;
  v_result_sequence bigint;
  v_result_id uuid;
  v_result_kind text;
  v_recorded_result jsonb;
  v_request_payload dasher.agent_run_attempt_payloads%ROWTYPE;
  v_request_body jsonb;
  v_request_payload_sha bytea;
  v_request_envelope_sha bytea;
  v_expected_dispatch_sha bytea;
  v_run_request_payload dasher.agent_run_request_payloads%ROWTYPE;
  v_run_request_body jsonb;
  v_run_request_semantic_sha bytea;
  v_stored_result dasher.agent_recorded_results%ROWTYPE;
  v_stored_result_payload dasher.agent_run_attempt_payloads%ROWTYPE;
  v_candidate_bytes bytea;
  v_candidate_sha bytea;
  v_candidate_assertions jsonb;
  v_precommit_bytes bytea;
  v_precommit_sha bytea;
  v_validator_source_sha bytea;
  v_mutation dasher_run_api.run_mutation_result;
  v_field record;
BEGIN
  IF p_outcome IS NULL
    OR p_outcome NOT IN ('succeeded', 'refused', 'failed', 'indeterminate')
    OR (p_outcome = 'indeterminate' AND (
      p_actual_accounting_bytes IS NOT NULL
      OR p_result_sha256 IS NOT NULL
      OR p_canonical_recorded_result_bytes IS NOT NULL
    ))
    OR (p_outcome <> 'indeterminate' AND (
      p_result_sha256 IS NULL
      OR pg_catalog.octet_length(p_result_sha256) <> 32
      OR p_canonical_recorded_result_bytes IS NULL
      OR pg_catalog.octet_length(p_canonical_recorded_result_bytes)
        NOT BETWEEN 1 AND 1114112
    ))
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  PERFORM dasher_private.initialize_run_operator_context_v1(p_run_id, 'reconcile');
  PERFORM dasher_private.reauthorize_agent_run_v1(p_run_id, p_lease_epoch, p_attempt_token);
  SELECT run.* INTO STRICT v_run FROM dasher.agent_runs AS run
  WHERE run.organization_id = current_setting('dasher.run_organization_id', true)::uuid
    AND run.run_id = p_run_id FOR UPDATE;
  SELECT policy.* INTO STRICT v_policy
  FROM dasher.agent_run_policy_revisions AS policy
  WHERE policy.policy_revision = v_run.policy_revision
  FOR UPDATE;
  SELECT attempt.* INTO STRICT v_discovered_attempt
  FROM dasher.agent_run_attempts AS attempt
  WHERE attempt.organization_id = v_run.organization_id
    AND attempt.dashboard_id = v_run.dashboard_id AND attempt.run_id = v_run.run_id
    AND attempt.attempt_id = p_attempt_id;
  v_attempt := v_discovered_attempt;

  IF v_attempt.state <> 'dispatch_started'
    AND v_attempt.state NOT IN (
      'succeeded', 'refused_charged', 'failed_charged',
      'indeterminate_quarantined'
    )
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;

  SELECT request_payload.* INTO STRICT v_request_payload
  FROM dasher.agent_run_attempt_payloads AS request_payload
  WHERE request_payload.organization_id = v_run.organization_id
    AND request_payload.dashboard_id = v_run.dashboard_id
    AND request_payload.run_id = v_run.run_id
    AND request_payload.attempt_id = v_attempt.attempt_id
    AND request_payload.payload_kind = 'request'
    AND request_payload.payload_id = v_attempt.request_payload_id;
  BEGIN
    v_request_body := pg_catalog.convert_from(
      v_request_payload.canonical_bytes, 'UTF8'
    )::jsonb;
  EXCEPTION
    WHEN SQLSTATE '22021' OR SQLSTATE '22P02' THEN
      RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END;
  IF v_request_body->>'common_bundle_sha256' !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  SELECT bundle.* INTO v_bundle
  FROM dasher.candidate_comparison_bundles AS bundle
  WHERE bundle.organization_id = v_run.organization_id
    AND bundle.dashboard_id = v_run.dashboard_id
    AND bundle.run_id = v_run.run_id
    AND bundle.bundle_sha256 = pg_catalog.decode(
      v_request_body->>'common_bundle_sha256', 'hex'
    )
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  SELECT pg_catalog.sha256(COALESCE(pg_catalog.string_agg(
      pg_catalog.uuid_send(member.evidence_id)
      || pg_catalog.uuid_send(member.source_snapshot_id)
      || member.evidence_sha256 || member.source_sha256
      || pg_catalog.int4send(pg_catalog.octet_length(member.freshness))
      || pg_catalog.convert_to(member.freshness, 'UTF8')
      || pg_catalog.int8send((pg_catalog.date_part('epoch',
          member.observed_at) * 1000000)::bigint),
      ''::bytea ORDER BY pg_catalog.uuid_send(member.evidence_id)
    ), ''::bytea)) INTO v_bundle_members_before
  FROM dasher.candidate_comparison_bundle_evidence AS member
  WHERE member.organization_id = v_bundle.organization_id
    AND member.dashboard_id = v_bundle.dashboard_id
    AND member.run_id = v_bundle.run_id
    AND member.bundle_id = v_bundle.bundle_id;
  SELECT attempt.* INTO STRICT v_attempt
  FROM dasher.agent_run_attempts AS attempt
  WHERE attempt.organization_id = v_run.organization_id
    AND attempt.dashboard_id = v_run.dashboard_id
    AND attempt.run_id = v_run.run_id
    AND attempt.attempt_id = p_attempt_id
  FOR UPDATE;
  IF v_attempt IS DISTINCT FROM v_discovered_attempt THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  v_request_payload_sha := pg_catalog.sha256(
    pg_catalog.convert_to('dasher.attempt-request.v1', 'UTF8')
    || pg_catalog.decode('00', 'hex')
    || pg_catalog.int4send(pg_catalog.octet_length(
      v_request_payload.canonical_bytes
    ))
    || v_request_payload.canonical_bytes
  );
  v_request_envelope_sha := pg_catalog.sha256(
    pg_catalog.convert_to('dasher.retained-payload-envelope.v1', 'UTF8')
    || pg_catalog.decode('00', 'hex')
    || pg_catalog.int4send(pg_catalog.octet_length('attempt-request-v1'))
    || pg_catalog.convert_to('attempt-request-v1', 'UTF8')
    || pg_catalog.int4send(pg_catalog.octet_length(
      v_request_payload.content_nonce
    ))
    || v_request_payload.content_nonce
    || pg_catalog.int4send(pg_catalog.octet_length(v_request_payload_sha))
    || v_request_payload_sha
  );
  v_expected_dispatch_sha := pg_catalog.sha256(
    pg_catalog.convert_to('dasher.attempt-dispatch-request.v1', 'UTF8')
    || pg_catalog.decode('00', 'hex')
    || pg_catalog.uuid_send(v_run.run_id)
    || pg_catalog.int8send(v_attempt.lease_epoch)
    || pg_catalog.uuid_send(v_attempt.attempt_id)
    || v_request_payload_sha
    || pg_catalog.int4send(pg_catalog.octet_length(v_policy.adapter_id))
    || pg_catalog.convert_to(v_policy.adapter_id, 'UTF8')
    || pg_catalog.int4send(pg_catalog.octet_length(v_policy.model_id))
    || pg_catalog.convert_to(v_policy.model_id, 'UTF8')
    || pg_catalog.int8send(v_policy.policy_revision)
    || pg_catalog.int4send(pg_catalog.octet_length(
      v_policy.price_book_revision
    ))
    || pg_catalog.convert_to(v_policy.price_book_revision, 'UTF8')
  );
  IF v_attempt.lease_epoch <> p_lease_epoch
    OR dasher_private.canonical_jsonb_bytes_v1(v_request_body)
      IS DISTINCT FROM v_request_payload.canonical_bytes
    OR v_request_body->>'schema' <> 'attempt-request-v1'
    OR v_request_body->>'attempt_id' <> v_attempt.attempt_id::text
    OR v_request_body->>'attempt_kind' <> v_attempt.attempt_kind
    OR v_request_body->>'adapter_id' <> v_policy.adapter_id
    OR v_request_body->>'model_id' <> v_policy.model_id
    OR v_request_body->>'policy_revision' <>
      'i64:' || v_policy.policy_revision::text
    OR v_request_body->>'price_book_revision' <>
      v_policy.price_book_revision
    OR v_request_body->>'instructions_sha256' <> pg_catalog.encode(
      CASE v_attempt.attempt_kind
        WHEN 'planner' THEN v_policy.planner_instructions_sha256
        WHEN 'generator' THEN v_policy.generator_instructions_sha256
        WHEN 'specialist' THEN v_policy.specialist_instructions_sha256
        WHEN 'repair' THEN v_policy.repair_instructions_sha256
        ELSE v_policy.reviewer_instructions_sha256
      END, 'hex'
    )
    OR v_request_payload.payload_sha256 IS DISTINCT FROM v_request_envelope_sha
    OR pg_catalog.octet_length(v_expected_dispatch_sha) <> 32
    OR v_attempt.dispatch_started_at IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM dasher.agent_run_events AS event
      WHERE event.organization_id = v_attempt.organization_id
        AND event.dashboard_id = v_attempt.dashboard_id
        AND event.run_id = v_attempt.run_id
        AND event.event_kind = 'attempt_dispatch_started'
        AND event.occurred_at = v_attempt.dispatch_started_at
    )
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  SELECT payload.* INTO STRICT v_run_request_payload
  FROM dasher.agent_run_request_payloads AS payload
  WHERE payload.organization_id = v_run.organization_id
    AND payload.dashboard_id = v_run.dashboard_id
    AND payload.request_payload_id = v_run.request_payload_id
    AND payload.run_request_id = v_run.run_request_id;
  BEGIN
    v_run_request_body := pg_catalog.convert_from(
      v_run_request_payload.canonical_bytes, 'UTF8'
    )::jsonb;
  EXCEPTION
    WHEN SQLSTATE '22021' OR SQLSTATE '22P02' THEN
      RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END;
  v_run_request_semantic_sha := pg_catalog.sha256(
    pg_catalog.convert_to('dasher.agent-run-request.v1', 'UTF8')
    || pg_catalog.decode('00', 'hex')
    || pg_catalog.int4send(pg_catalog.octet_length(
      v_run_request_payload.canonical_bytes
    )) || v_run_request_payload.canonical_bytes
  );
  IF dasher_private.canonical_jsonb_bytes_v1(v_run_request_body)
      IS DISTINCT FROM v_run_request_payload.canonical_bytes
    OR v_run_request_body->>'run_request_id' <> v_run.run_request_id::text
    OR v_run_request_body->>'policy_revision' <>
      'i64:' || v_run.policy_revision::text
    OR v_run_request_payload.request_sha256 IS DISTINCT FROM
      pg_catalog.sha256(
        pg_catalog.convert_to('dasher.retained-payload-envelope.v1', 'UTF8')
        || pg_catalog.decode('00', 'hex')
        || pg_catalog.int4send(pg_catalog.octet_length(
          'agent-run-request-v1'
        )) || pg_catalog.convert_to('agent-run-request-v1', 'UTF8')
        || pg_catalog.int4send(pg_catalog.octet_length(
          v_run_request_payload.content_nonce
        )) || v_run_request_payload.content_nonce
        || pg_catalog.int4send(pg_catalog.octet_length(
          v_run_request_semantic_sha
        )) || v_run_request_semantic_sha
      )
    OR v_request_body->>'input_sha256' <>
      v_run_request_body->>'input_sha256'
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;

  IF p_outcome <> 'indeterminate' THEN
    v_result_semantic_sha := pg_catalog.sha256(
      pg_catalog.convert_to('dasher.recorded-result.v1', 'UTF8')
      || pg_catalog.decode('00', 'hex')
      || pg_catalog.int4send(
        pg_catalog.octet_length(p_canonical_recorded_result_bytes)
      )
      || p_canonical_recorded_result_bytes
    );
    IF v_result_semantic_sha <> p_result_sha256 THEN
      RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
    END IF;
    BEGIN
      v_recorded_result := pg_catalog.convert_from(
        p_canonical_recorded_result_bytes, 'UTF8'
      )::jsonb;
      v_result_id := (v_recorded_result->>'result_id')::uuid;
    EXCEPTION
      WHEN SQLSTATE '22021' OR SQLSTATE '22P02' THEN
        RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
    END;
    IF dasher_private.canonical_jsonb_bytes_v1(v_recorded_result)
        IS DISTINCT FROM p_canonical_recorded_result_bytes
    THEN
      RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
    END IF;
    v_payload_sha := pg_catalog.sha256(
      pg_catalog.convert_to('dasher.retained-payload-envelope.v1', 'UTF8')
      || pg_catalog.decode('00', 'hex')
      || pg_catalog.int4send(pg_catalog.octet_length('recorded-result-v1'))
      || pg_catalog.convert_to('recorded-result-v1', 'UTF8')
      || pg_catalog.int4send(pg_catalog.octet_length(v_nonce))
      || v_nonce
      || pg_catalog.int4send(pg_catalog.octet_length(v_result_semantic_sha))
      || v_result_semantic_sha
    );
    v_result_kind := v_recorded_result->>'result_kind';
    IF pg_catalog.jsonb_typeof(v_recorded_result) <> 'object'
      OR (SELECT pg_catalog.count(*)
          FROM pg_catalog.jsonb_object_keys(v_recorded_result)) <> 9
      OR NOT v_recorded_result ?& ARRAY[
        'schema','result_id','attempt_id','attempt_kind','adapter_id',
        'model_id','request_sha256','result_kind','result'
      ]
      OR v_recorded_result->>'schema' <> 'recorded-result-v1'
      OR v_recorded_result->>'attempt_id' <> v_attempt.attempt_id::text
      OR v_recorded_result->>'attempt_kind' <> v_attempt.attempt_kind
      OR v_recorded_result->>'adapter_id' <> v_request_body->>'adapter_id'
      OR v_recorded_result->>'model_id' <> v_request_body->>'model_id'
      OR v_request_payload.payload_sha256 <> v_request_envelope_sha
      OR v_recorded_result->>'request_sha256'
        <> pg_catalog.encode(v_request_payload_sha, 'hex')
      OR (p_outcome = 'refused' AND v_result_kind <> 'refusal')
      OR (p_outcome = 'failed' AND v_result_kind <> 'failure')
      OR (p_outcome = 'succeeded' AND (
        (v_attempt.attempt_kind = 'planner'
          AND v_result_kind <> 'planner_output')
        OR (v_attempt.attempt_kind = 'specialist'
          AND v_result_kind <> 'specialist_output')
        OR (v_attempt.attempt_kind = 'reviewer'
          AND v_result_kind <> 'reviewer_verdict_set')
        OR (v_attempt.attempt_kind = 'repair'
          AND v_result_kind <> 'repair_output')
        OR (v_attempt.attempt_kind = 'generator'
          AND v_result_kind NOT IN ('candidate_output', 'candidate_invalid'))
      ))
      OR (p_outcome IN ('refused', 'failed')
        AND pg_catalog.jsonb_typeof(v_recorded_result->'result') <> 'object')
      OR (p_outcome IN ('refused', 'failed') AND (
        (SELECT pg_catalog.count(*)
         FROM pg_catalog.jsonb_object_keys(v_recorded_result->'result')) <> 3
        OR NOT v_recorded_result->'result' ?& ARRAY[
          'schema','reason_code','retryable'
        ]
        OR pg_catalog.jsonb_typeof(
          v_recorded_result#>'{result,schema}'
        ) <> 'string'
        OR pg_catalog.octet_length(pg_catalog.convert_to(
          v_recorded_result#>>'{result,schema}', 'UTF8'
        )) NOT BETWEEN 1 AND 64
        OR v_recorded_result#>>'{result,reason_code}' NOT IN (
          'policy_refusal','insufficient_context','adapter_error','timeout',
          'malformed_output'
        )
        OR pg_catalog.jsonb_typeof(
          v_recorded_result#>'{result,retryable}'
        ) <> 'boolean'
        OR ((v_recorded_result#>>'{result,retryable}')::boolean
          AND v_recorded_result#>>'{result,reason_code}' NOT IN (
            'adapter_error','timeout'
          ))
      ))
      OR (p_outcome = 'succeeded'
        AND v_result_kind IN ('candidate_output', 'repair_output')
        AND v_recorded_result#>>'{result,precommit_validation,state}' <> 'valid')
      OR (p_outcome = 'succeeded'
        AND v_result_kind = 'candidate_invalid'
        AND v_recorded_result#>>'{result,precommit_validation,state}' <> 'invalid')
    THEN
      RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
    END IF;
    IF p_outcome = 'succeeded' AND v_result_kind = 'planner_output' AND (
        pg_catalog.jsonb_typeof(v_recorded_result->'result') <> 'object'
        OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(
          v_recorded_result->'result'
        )) <> 10
        OR NOT v_recorded_result->'result' ?& ARRAY[
          'schema','brief_id','bundle_id','goal','metric_contract_ids',
          'dimension_field_ids','requested_views','constraints',
          'specialist_required','candidate_target_count'
        ]
        OR v_recorded_result#>>'{result,schema}' <> 'agent-brief-v1'
        OR v_recorded_result#>>'{result,brief_id}' !~
          '^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        OR NOT EXISTS (
          SELECT 1
          FROM dasher.candidate_comparison_bundles AS bundle
          WHERE bundle.organization_id = v_run.organization_id
            AND bundle.dashboard_id = v_run.dashboard_id
            AND bundle.run_id = v_run.run_id
            AND bundle.bundle_id =
              (v_recorded_result#>>'{result,bundle_id}')::uuid
            AND bundle.bundle_sha256 = pg_catalog.decode(
              v_request_body->>'common_bundle_sha256', 'hex'
            )
        )
        OR pg_catalog.jsonb_typeof(
          v_recorded_result#>'{result,goal}'
        ) <> 'string'
        OR pg_catalog.octet_length(pg_catalog.convert_to(
          v_recorded_result#>>'{result,goal}', 'UTF8'
        )) NOT BETWEEN 1 AND 1000
        OR pg_catalog.jsonb_typeof(
          v_recorded_result#>'{result,metric_contract_ids}'
        ) <> 'array'
        OR pg_catalog.jsonb_array_length(
          v_recorded_result#>'{result,metric_contract_ids}'
        ) NOT BETWEEN 1 AND 16
        OR EXISTS (
          SELECT 1
          FROM pg_catalog.jsonb_array_elements_text(
            v_recorded_result#>'{result,metric_contract_ids}'
          ) WITH ORDINALITY AS member(value, ordinal)
          WHERE member.value !~
              '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
            OR NOT EXISTS (
              SELECT 1
              FROM dasher.metric_contract_versions AS contract
              WHERE contract.organization_id = v_run.organization_id
                AND contract.dashboard_id = v_run.dashboard_id
                AND contract.contract_set_id = (
                  v_run_request_body->'metric_contract_set'
                    ->>'contract_set_id'
                )::uuid
                AND contract.contract_id = member.value::uuid
            )
            OR EXISTS (
              SELECT 1
              FROM pg_catalog.jsonb_array_elements_text(
                v_recorded_result#>'{result,metric_contract_ids}'
              ) WITH ORDINALITY AS prior(value, ordinal)
              WHERE prior.ordinal = member.ordinal - 1
                AND pg_catalog.uuid_send(prior.value::uuid) >=
                  pg_catalog.uuid_send(member.value::uuid)
            )
        )
        OR pg_catalog.jsonb_typeof(
          v_recorded_result#>'{result,dimension_field_ids}'
        ) <> 'array'
        OR pg_catalog.jsonb_array_length(
          v_recorded_result#>'{result,dimension_field_ids}'
        ) NOT BETWEEN 0 AND 32
        OR EXISTS (
          SELECT 1
          FROM pg_catalog.jsonb_array_elements_text(
            v_recorded_result#>'{result,dimension_field_ids}'
          ) WITH ORDINALITY AS dimension(value, ordinal)
          WHERE dimension.value !~
              '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
            OR NOT EXISTS (
              SELECT 1 FROM dasher.field_catalog_entries AS field
              WHERE field.organization_id = v_run.organization_id
                AND field.dashboard_id = v_run.dashboard_id
                AND field.catalog_snapshot_id = (
                  v_run_request_body->'field_catalog'
                    ->>'catalog_snapshot_id'
                )::uuid
                AND field.field_id = dimension.value::uuid
            )
            OR EXISTS (
              SELECT 1
              FROM pg_catalog.jsonb_array_elements_text(
                v_recorded_result#>'{result,dimension_field_ids}'
              ) WITH ORDINALITY AS prior(value, ordinal)
              WHERE prior.ordinal = dimension.ordinal - 1
                AND pg_catalog.uuid_send(prior.value::uuid) >=
                  pg_catalog.uuid_send(dimension.value::uuid)
            )
        )
        OR pg_catalog.jsonb_typeof(
          v_recorded_result#>'{result,requested_views}'
        ) <> 'array'
        OR pg_catalog.jsonb_array_length(
          v_recorded_result#>'{result,requested_views}'
        ) NOT BETWEEN 1 AND 8
        OR EXISTS (
          SELECT 1
          FROM pg_catalog.jsonb_array_elements_text(
            v_recorded_result#>'{result,requested_views}'
          ) WITH ORDINALITY AS view(value, ordinal)
          WHERE view.value NOT IN ('metric','table','bar','line','scatter')
            OR EXISTS (
              SELECT 1
              FROM pg_catalog.jsonb_array_elements_text(
                v_recorded_result#>'{result,requested_views}'
              ) WITH ORDINALITY AS prior(value, ordinal)
              WHERE prior.ordinal = view.ordinal - 1
                AND pg_catalog.array_position(
                  ARRAY['metric','table','bar','line','scatter'], prior.value
                ) >= pg_catalog.array_position(
                  ARRAY['metric','table','bar','line','scatter'], view.value
                )
            )
        )
        OR pg_catalog.jsonb_typeof(
          v_recorded_result#>'{result,constraints}'
        ) <> 'array'
        OR pg_catalog.jsonb_array_length(
          v_recorded_result#>'{result,constraints}'
        ) NOT BETWEEN 0 AND 16
        OR EXISTS (
          SELECT 1
          FROM pg_catalog.jsonb_array_elements_text(
            v_recorded_result#>'{result,constraints}'
          ) WITH ORDINALITY AS constraint_item(value, ordinal)
          WHERE pg_catalog.octet_length(pg_catalog.convert_to(
              constraint_item.value, 'UTF8'
            )) NOT BETWEEN 1 AND 256
            OR EXISTS (
              SELECT 1
              FROM pg_catalog.jsonb_array_elements_text(
                v_recorded_result#>'{result,constraints}'
              ) WITH ORDINALITY AS prior(value, ordinal)
              WHERE prior.ordinal = constraint_item.ordinal - 1
                AND pg_catalog.convert_to(prior.value, 'UTF8') >=
                  pg_catalog.convert_to(constraint_item.value, 'UTF8')
            )
        )
        OR pg_catalog.jsonb_typeof(
          v_recorded_result#>'{result,specialist_required}'
        ) <> 'boolean'
        OR v_recorded_result#>>'{result,candidate_target_count}'
          NOT IN ('i64:1','i64:2')
      ) THEN
      RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
    ELSIF p_outcome = 'succeeded'
      AND v_result_kind = 'specialist_output' AND (
        pg_catalog.jsonb_typeof(v_recorded_result->'result') <> 'object'
        OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(
          v_recorded_result->'result'
        )) <> 3
        OR NOT v_recorded_result->'result' ?& ARRAY[
          'schema','bundle_sha256','observations'
        ]
        OR v_recorded_result#>>'{result,schema}' <>
          'specialist-output-v1'
        OR v_recorded_result#>>'{result,bundle_sha256}' <>
          v_request_body->>'common_bundle_sha256'
        OR pg_catalog.jsonb_typeof(
          v_recorded_result#>'{result,observations}'
        ) <> 'array'
        OR pg_catalog.jsonb_array_length(
          v_recorded_result#>'{result,observations}'
        ) NOT BETWEEN 1 AND 32
        OR EXISTS (
          SELECT 1 FROM pg_catalog.jsonb_array_elements_text(
            v_recorded_result#>'{result,observations}'
          ) WITH ORDINALITY AS observation(value, ordinal)
          WHERE pg_catalog.octet_length(observation.value) NOT BETWEEN 1 AND 1000
            OR EXISTS (
              SELECT 1 FROM pg_catalog.jsonb_array_elements_text(
                v_recorded_result#>'{result,observations}'
              ) WITH ORDINALITY AS prior(value, ordinal)
              WHERE prior.ordinal = observation.ordinal - 1
                AND pg_catalog.convert_to(prior.value, 'UTF8') >=
                  pg_catalog.convert_to(observation.value, 'UTF8')
            )
        )
      ) THEN
      RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
    ELSIF p_outcome = 'succeeded' AND v_result_kind IN (
      'candidate_output','candidate_invalid','repair_output'
    ) THEN
      IF pg_catalog.jsonb_typeof(v_recorded_result->'result') <> 'object'
        OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(
          v_recorded_result->'result'
        )) <> 2
        OR NOT v_recorded_result->'result' ?& ARRAY[
          'dashboard_spec','precommit_validation'
        ]
      THEN
        RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
      END IF;
      v_candidate_bytes := dasher_private.canonical_dashboard_jsonb_bytes_v1(
        v_recorded_result#>'{result,dashboard_spec}'
      );
      v_candidate_sha := pg_catalog.sha256(
        pg_catalog.convert_to('dasher.dashboard-spec.v1', 'UTF8')
        || pg_catalog.decode('00', 'hex')
        || pg_catalog.int4send(pg_catalog.octet_length(v_candidate_bytes))
        || v_candidate_bytes
      );
      v_precommit_bytes := dasher_private.canonical_jsonb_bytes_v1(
        v_recorded_result#>'{result,precommit_validation}'
      );
      v_precommit_sha := pg_catalog.sha256(
        pg_catalog.convert_to(
          'dasher.precommit-dashboard-validation.v1', 'UTF8'
        ) || pg_catalog.decode('00', 'hex')
        || pg_catalog.int4send(pg_catalog.octet_length(v_precommit_bytes))
        || v_precommit_bytes
      );
      v_validator_source_sha := pg_catalog.sha256(
        pg_catalog.convert_to(
          'dasher.precommit-validator-source.v1', 'UTF8'
        ) || pg_catalog.decode('00', 'hex')
        || pg_catalog.decode(
          'dfdbbba8f6202cff2eeddaf82cbc4e2989f30982334351b174926dcd568fd8b2',
          'hex'
        )
        || pg_catalog.int4send(pg_catalog.octet_length(
          'material-assertions-v1'
        )) || pg_catalog.convert_to('material-assertions-v1', 'UTF8')
        || pg_catalog.int4send(pg_catalog.octet_length(
          'bundle-evidence-uuid-v1'
        )) || pg_catalog.convert_to('bundle-evidence-uuid-v1', 'UTF8')
        || pg_catalog.int4send(pg_catalog.octet_length('demo-data-mode-v1'))
        || pg_catalog.convert_to('demo-data-mode-v1', 'UTF8')
      );
      v_candidate_assertions := CASE
        WHEN dasher_private.validate_dashboard_spec_v1(v_candidate_bytes)
          THEN dasher_private.extract_material_assertions_v1(
            v_candidate_bytes, v_candidate_sha
          ) ELSE NULL END;
      IF pg_catalog.octet_length(v_precommit_bytes) NOT BETWEEN 1 AND 16384
        OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(
          v_recorded_result#>'{result,precommit_validation}'
        )) <> 6
        OR v_recorded_result#>>'{result,precommit_validation,schema}' <>
          'precommit-dashboard-validation-v1'
        OR v_recorded_result#>>'{result,precommit_validation,candidate_spec_sha256}' <>
          pg_catalog.encode(v_candidate_sha, 'hex')
        OR v_recorded_result#>>'{result,precommit_validation,validator_id}' <>
          '@dasher/dashboard-schema@0.1.0+task9-candidate-v1'
        OR v_recorded_result#>>'{result,precommit_validation,validator_source_sha256}' <>
          pg_catalog.encode(v_validator_source_sha, 'hex')
        OR v_recorded_result#>>'{result,precommit_validation,state}'
          NOT IN ('valid','invalid')
        OR pg_catalog.jsonb_typeof(
          v_recorded_result#>'{result,precommit_validation,error_codes}'
        ) <> 'array'
        OR pg_catalog.jsonb_array_length(
          v_recorded_result#>'{result,precommit_validation,error_codes}'
        ) NOT BETWEEN 0 AND 64
        OR EXISTS (
          SELECT 1
          FROM pg_catalog.jsonb_array_elements_text(
            v_recorded_result#>'{result,precommit_validation,error_codes}'
          ) WITH ORDINALITY AS error_code(value, ordinal)
          WHERE error_code.value NOT IN (
              'schema','size','complexity','duplicate_id','missing_evidence',
              'invalid_evidence_time','invalid_architecture_edge',
              'unsupported_version','material_claim_limit',
              'unsupported_data_mode'
            )
            OR EXISTS (
              SELECT 1
              FROM pg_catalog.jsonb_array_elements_text(
                v_recorded_result
                  #>'{result,precommit_validation,error_codes}'
              ) WITH ORDINALITY AS prior(value, ordinal)
              WHERE prior.ordinal = error_code.ordinal - 1
                AND pg_catalog.convert_to(prior.value, 'UTF8') >=
                  pg_catalog.convert_to(error_code.value, 'UTF8')
            )
        )
        OR (v_result_kind IN ('candidate_output','repair_output') AND (
          dasher_private.validate_dashboard_spec_v1(v_candidate_bytes)
            IS DISTINCT FROM true
          OR v_recorded_result#>>'{result,dashboard_spec,dataMode}' <> 'demo'
          OR pg_catalog.jsonb_array_length(v_candidate_assertions)
            NOT BETWEEN 1 AND 64
          OR EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_array_elements(
              v_recorded_result#>'{result,dashboard_spec,evidence}'
            ) AS evidence(value)
            WHERE NOT EXISTS (
              SELECT 1
              FROM dasher.candidate_comparison_bundle_evidence AS member
              JOIN dasher.candidate_comparison_bundles AS bundle
                ON bundle.organization_id = member.organization_id
               AND bundle.dashboard_id = member.dashboard_id
               AND bundle.run_id = member.run_id
               AND bundle.bundle_id = member.bundle_id
              WHERE member.organization_id = v_run.organization_id
                AND member.dashboard_id = v_run.dashboard_id
                AND member.run_id = v_run.run_id
                AND bundle.bundle_sha256 = pg_catalog.decode(
                  v_request_body->>'common_bundle_sha256', 'hex'
                )
                AND member.evidence_id =
                  (evidence.value->>'id')::uuid
            )
          )
          OR v_recorded_result#>>'{result,precommit_validation,state}' <>
            'valid'
          OR v_recorded_result#>'{result,precommit_validation,error_codes}' <>
            '[]'::jsonb
        ))
        OR (v_result_kind = 'candidate_invalid' AND (
          v_recorded_result#>>'{result,precommit_validation,state}' <>
            'invalid'
          OR pg_catalog.jsonb_array_length(
            v_recorded_result#>'{result,precommit_validation,error_codes}'
          ) NOT BETWEEN 1 AND 64
        ))
        OR v_precommit_sha IS NULL
      THEN
        RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
      END IF;
    ELSIF p_outcome = 'succeeded'
      AND v_result_kind = 'reviewer_verdict_set' AND (
        pg_catalog.jsonb_typeof(v_recorded_result->'result') <> 'object'
        OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(
          v_recorded_result->'result'
        )) <> 5
        OR NOT v_recorded_result->'result' ?& ARRAY[
          'schema','candidate_set_sha256','candidate_validation_set_sha256',
          'candidate_claim_sets_sha256','verdicts'
        ]
        OR v_recorded_result#>>'{result,schema}' <>
          'reviewer-verdict-set-v1'
        OR v_recorded_result#>>'{result,candidate_set_sha256}' <>
          v_request_body->>'candidate_set_sha256'
        OR v_recorded_result#>>'{result,candidate_validation_set_sha256}' <>
          v_request_body->>'candidate_validation_set_sha256'
        OR v_recorded_result#>>'{result,candidate_claim_sets_sha256}' <>
          v_request_body->>'candidate_claim_sets_sha256'
        OR pg_catalog.jsonb_array_length(
          v_recorded_result#>'{result,verdicts}'
        ) NOT BETWEEN 1 AND 2
        OR pg_catalog.jsonb_array_length(
          v_recorded_result#>'{result,verdicts}'
        ) <> (
          SELECT pg_catalog.count(*)
          FROM dasher.agent_candidates AS candidate
          WHERE candidate.organization_id = v_run.organization_id
            AND candidate.dashboard_id = v_run.dashboard_id
            AND candidate.run_id = v_run.run_id
        )
        OR EXISTS (
          SELECT 1
          FROM pg_catalog.jsonb_array_elements(
            v_recorded_result#>'{result,verdicts}'
          ) WITH ORDINALITY AS verdict(value, ordinal)
          WHERE pg_catalog.jsonb_typeof(verdict.value) <> 'object'
            OR (SELECT pg_catalog.count(*)
                FROM pg_catalog.jsonb_object_keys(verdict.value)) <> 4
            OR NOT verdict.value ?& ARRAY[
              'candidate_id','candidate_spec_sha256','verdict','reason_codes'
            ]
            OR verdict.value->>'candidate_id' !~
              '^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
            OR verdict.value->>'candidate_spec_sha256' !~
              '^[0-9a-f]{64}$'
            OR verdict.value->>'verdict' NOT IN (
              'preferred','acceptable','reject'
            )
            OR pg_catalog.jsonb_typeof(
              verdict.value->'reason_codes'
            ) <> 'array'
            OR pg_catalog.jsonb_array_length(
              verdict.value->'reason_codes'
            ) NOT BETWEEN 0 AND 8
            OR NOT EXISTS (
              SELECT 1 FROM dasher.agent_candidates AS candidate
              WHERE candidate.organization_id = v_run.organization_id
                AND candidate.dashboard_id = v_run.dashboard_id
                AND candidate.run_id = v_run.run_id
                AND candidate.candidate_id =
                  (verdict.value->>'candidate_id')::uuid
                AND candidate.candidate_spec_sha256 = pg_catalog.decode(
                  verdict.value->>'candidate_spec_sha256', 'hex'
                )
            )
            OR EXISTS (
              SELECT 1
              FROM pg_catalog.jsonb_array_elements_text(
                verdict.value->'reason_codes'
              ) WITH ORDINALITY AS reason(value, ordinal)
              WHERE reason.value NOT IN (
                  'evidence_gap','calculation_error','policy_violation',
                  'misleading_encoding','unsupported_claim','stale_source',
                  'inconsistent_bundle','invalid_spec'
                )
                OR EXISTS (
                  SELECT 1
                  FROM pg_catalog.jsonb_array_elements_text(
                    verdict.value->'reason_codes'
                  ) WITH ORDINALITY AS prior(value, ordinal)
                  WHERE prior.ordinal = reason.ordinal - 1
                    AND pg_catalog.convert_to(prior.value, 'UTF8') >=
                      pg_catalog.convert_to(reason.value, 'UTF8')
                )
            )
            OR (verdict.value->>'verdict' IN ('preferred','acceptable')
              AND verdict.value->'reason_codes' ?| ARRAY[
                'policy_violation','misleading_encoding','invalid_spec'
              ])
            OR (verdict.value->>'verdict' = 'reject'
              AND pg_catalog.jsonb_array_length(
                verdict.value->'reason_codes'
              ) = 0)
            OR EXISTS (
              SELECT 1
              FROM pg_catalog.jsonb_array_elements(
                v_recorded_result#>'{result,verdicts}'
              ) WITH ORDINALITY AS prior(value, ordinal)
              WHERE prior.ordinal = verdict.ordinal - 1
                AND pg_catalog.uuid_send(
                  (prior.value->>'candidate_id')::uuid
                ) >= pg_catalog.uuid_send(
                  (verdict.value->>'candidate_id')::uuid
                )
            )
        )
      ) THEN
      RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
    END IF;
  END IF;

  IF p_outcome = 'indeterminate' THEN
    v_indeterminate_reason := 'caller_indeterminate';
  ELSE
    BEGIN
      IF p_actual_accounting_bytes IS NULL
        OR pg_catalog.octet_length(p_actual_accounting_bytes) NOT BETWEEN 1 AND 1024
      THEN
        v_malformed := true;
      ELSE
        FOR v_index IN 0..pg_catalog.octet_length(p_actual_accounting_bytes) - 1
        LOOP
          v_octet := pg_catalog.get_byte(p_actual_accounting_bytes, v_index);
          IF NOT (
            v_octet BETWEEN 97 AND 122
            OR v_octet BETWEEN 48 AND 57
            OR v_octet IN (34, 44, 45, 58, 95, 123, 125)
          ) THEN
            v_malformed := true;
            EXIT;
          END IF;
        END LOOP;
      END IF;

      IF NOT v_malformed THEN
        v_accounting_text := pg_catalog.convert_from(
          p_actual_accounting_bytes, 'UTF8'
        );
        IF pg_catalog.length(v_accounting_text)
              - pg_catalog.length(pg_catalog.replace(v_accounting_text, '"', '')) <> 60
          OR pg_catalog.length(v_accounting_text)
              - pg_catalog.length(pg_catalog.replace(v_accounting_text, ':', '')) <> 29
          OR pg_catalog.length(v_accounting_text)
              - pg_catalog.length(pg_catalog.replace(v_accounting_text, ',', '')) <> 14
          OR pg_catalog.length(v_accounting_text)
              - pg_catalog.length(pg_catalog.replace(v_accounting_text, '{', '')) <> 1
          OR pg_catalog.length(v_accounting_text)
              - pg_catalog.length(pg_catalog.replace(v_accounting_text, '}', '')) <> 1
          OR pg_catalog.left(v_accounting_text, 1) <> '{'
          OR pg_catalog.right(v_accounting_text, 1) <> '}'
        THEN
          v_malformed := true;
        END IF;
      END IF;

      IF NOT v_malformed THEN
        v_accounting := v_accounting_text::jsonb;
        IF pg_catalog.jsonb_typeof(v_accounting) <> 'object' THEN
          v_malformed := true;
        ELSE
          SELECT pg_catalog.array_agg(key_name ORDER BY key_name)
            INTO v_accounting_keys
          FROM pg_catalog.jsonb_object_keys(v_accounting) AS key_name;
          IF v_accounting_keys IS DISTINCT FROM ARRAY[
            'cache_read_tokens', 'cache_write_tokens', 'calls', 'candidates',
            'cost_micros', 'input_tokens', 'output_tokens', 'reasoning_tokens',
            'repair_attempts', 'reviewer_attempts', 'schema',
            'specialist_attempts', 'total_tokens', 'wall_millis', 'work_millis'
          ]::text[]
          THEN
            v_malformed := true;
          END IF;
        END IF;
      END IF;

      IF NOT v_malformed THEN
        FOREACH v_key IN ARRAY ARRAY[
          'cache_read_tokens', 'cache_write_tokens', 'calls', 'candidates',
          'cost_micros', 'input_tokens', 'output_tokens', 'reasoning_tokens',
          'repair_attempts', 'reviewer_attempts', 'specialist_attempts',
          'total_tokens', 'wall_millis', 'work_millis'
        ]::text[]
        LOOP
          IF pg_catalog.jsonb_typeof(v_accounting->v_key) <> 'string' THEN
            v_malformed := true;
            EXIT;
          END IF;
          v_tagged_value := v_accounting->>v_key;
          IF pg_catalog.left(v_tagged_value, 4) <> 'i64:'
            OR pg_catalog.length(v_tagged_value) < 5
          THEN
            v_malformed := true;
            EXIT;
          END IF;
          v_decimal := pg_catalog.substr(v_tagged_value, 5);
          IF pg_catalog.left(v_decimal, 1) = '-' THEN
            v_digit_start := 2;
            IF pg_catalog.length(v_decimal) < 2
              OR pg_catalog.get_byte(
                pg_catalog.convert_to(v_decimal, 'UTF8'), 1
              ) NOT BETWEEN 49 AND 57
            THEN
              v_malformed := true;
              EXIT;
            END IF;
          ELSE
            v_digit_start := 1;
            IF (v_decimal = '0') THEN
              NULL;
            ELSIF pg_catalog.get_byte(
                pg_catalog.convert_to(v_decimal, 'UTF8'), 0
              ) NOT BETWEEN 49 AND 57
            THEN
              v_malformed := true;
              EXIT;
            END IF;
          END IF;
          IF pg_catalog.length(v_decimal) >= v_digit_start + 1 THEN
            FOR v_index IN v_digit_start..pg_catalog.length(v_decimal) - 1
            LOOP
              IF pg_catalog.get_byte(
                  pg_catalog.convert_to(v_decimal, 'UTF8'), v_index
                ) NOT BETWEEN 48 AND 57
              THEN
                v_malformed := true;
                EXIT;
              END IF;
            END LOOP;
          END IF;
          EXIT WHEN v_malformed;
          v_vector_json := v_vector_json || pg_catalog.jsonb_build_object(
            v_key, v_decimal::bigint
          );
        END LOOP;
      END IF;

      IF NOT v_malformed THEN
        IF pg_catalog.jsonb_typeof(v_accounting->'schema') <> 'string'
          OR v_accounting->>'schema' <> 'attempt-actual-accounting-v1'
        THEN
          v_malformed := true;
        ELSE
          v_reconstructed_accounting :=
            '{"cache_read_tokens":"' || (v_accounting->>'cache_read_tokens')
            || '","cache_write_tokens":"' || (v_accounting->>'cache_write_tokens')
            || '","calls":"' || (v_accounting->>'calls')
            || '","candidates":"' || (v_accounting->>'candidates')
            || '","cost_micros":"' || (v_accounting->>'cost_micros')
            || '","input_tokens":"' || (v_accounting->>'input_tokens')
            || '","output_tokens":"' || (v_accounting->>'output_tokens')
            || '","reasoning_tokens":"' || (v_accounting->>'reasoning_tokens')
            || '","repair_attempts":"' || (v_accounting->>'repair_attempts')
            || '","reviewer_attempts":"' || (v_accounting->>'reviewer_attempts')
            || '","schema":"attempt-actual-accounting-v1"'
            || ',"specialist_attempts":"' || (v_accounting->>'specialist_attempts')
            || '","total_tokens":"' || (v_accounting->>'total_tokens')
            || '","wall_millis":"' || (v_accounting->>'wall_millis')
            || '","work_millis":"' || (v_accounting->>'work_millis') || '"}';
          IF pg_catalog.convert_to(v_reconstructed_accounting, 'UTF8')
              <> p_actual_accounting_bytes
          THEN
            v_malformed := true;
          ELSE
            v_actual := ROW(
              (v_vector_json->>'calls')::bigint,
              (v_vector_json->>'candidates')::bigint,
              (v_vector_json->>'specialist_attempts')::bigint,
              (v_vector_json->>'reviewer_attempts')::bigint,
              (v_vector_json->>'repair_attempts')::bigint,
              (v_vector_json->>'input_tokens')::bigint,
              (v_vector_json->>'output_tokens')::bigint,
              (v_vector_json->>'reasoning_tokens')::bigint,
              (v_vector_json->>'cache_read_tokens')::bigint,
              (v_vector_json->>'cache_write_tokens')::bigint,
              (v_vector_json->>'total_tokens')::bigint,
              (v_vector_json->>'wall_millis')::bigint,
              (v_vector_json->>'work_millis')::bigint,
              (v_vector_json->>'cost_micros')::bigint
            )::dasher_run_api.attempt_resource_vector;
          END IF;
        END IF;
      END IF;
    EXCEPTION
      WHEN SQLSTATE '22021' OR SQLSTATE '22P02' OR SQLSTATE '22003' THEN
        v_malformed := true;
    END;

    IF NOT v_malformed AND (
      EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_each_text(pg_catalog.to_jsonb(v_actual)) AS item
        WHERE item.value::bigint < 0
      )
      OR (v_actual).calls <> 1
      OR (v_actual).specialist_attempts <>
        CASE WHEN v_attempt.attempt_kind = 'specialist' THEN 1 ELSE 0 END
      OR (v_actual).reviewer_attempts <>
        CASE WHEN v_attempt.attempt_kind = 'reviewer' THEN 1 ELSE 0 END
      OR (v_actual).repair_attempts <>
        CASE WHEN v_attempt.attempt_kind = 'repair' THEN 1 ELSE 0 END
      OR (v_actual).candidates <> CASE
        WHEN p_outcome = 'succeeded'
          AND v_result_kind IN ('candidate_output', 'repair_output') THEN 1
        ELSE 0 END
      OR (v_actual).reasoning_tokens > (v_actual).output_tokens
      OR (v_actual).cache_read_tokens > (v_actual).input_tokens
      OR (v_actual).total_tokens::numeric <>
        (v_actual).input_tokens::numeric + (v_actual).output_tokens::numeric
      OR (v_actual).cost_micros::numeric <>
        2::numeric * (v_actual).input_tokens::numeric
          + 4::numeric * (v_actual).output_tokens::numeric
    ) THEN
      v_malformed := true;
    END IF;
    IF v_malformed THEN
      v_indeterminate_reason := 'malformed_accounting';
    ELSIF EXISTS (
      SELECT 1
      FROM pg_catalog.jsonb_each_text(pg_catalog.to_jsonb(v_actual)) AS actual
      JOIN pg_catalog.jsonb_each_text(
        pg_catalog.to_jsonb(v_attempt.reserved_vector)
      ) AS reserved ON reserved.key = actual.key
      WHERE actual.value::bigint > reserved.value::bigint
    ) THEN
      v_indeterminate_reason := 'actual_over_reservation';
    END IF;
  END IF;

  IF v_attempt.state = 'indeterminate_quarantined' THEN
    IF v_indeterminate_reason IS NULL
      OR v_run.state <> 'failed'
      OR v_attempt.actual_vector IS NOT NULL
      OR v_attempt.terminal_reason_sha256 IS DISTINCT FROM pg_catalog.sha256(
        pg_catalog.convert_to(
          'dasher.attempt-indeterminate-reason.v1', 'UTF8'
        ) || pg_catalog.decode('00', 'hex')
        || pg_catalog.convert_to(v_indeterminate_reason, 'UTF8')
      )
      OR v_attempt.used_vector IS DISTINCT FROM ROW(
        (v_attempt.reserved_vector).calls, 0,
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
      )::dasher_run_api.attempt_resource_vector
      OR v_attempt.released_vector IS DISTINCT FROM ROW(
        0, (v_attempt.reserved_vector).candidates, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0
      )::dasher_run_api.attempt_resource_vector
      OR v_attempt.outstanding_vector IS DISTINCT FROM v_zero
      OR v_attempt.reconciled_at IS NULL
      OR NOT EXISTS (
        SELECT 1
        FROM dasher.agent_run_events AS event
        WHERE event.organization_id = v_attempt.organization_id
          AND event.dashboard_id = v_attempt.dashboard_id
          AND event.run_id = v_attempt.run_id
          AND event.event_kind = 'attempt_indeterminate'
          AND event.event_id = dasher_private.uuid_v8_from_sha256_v1(
            pg_catalog.convert_to(
              'dasher.attempt-indeterminate-event-id.v1|'
                || v_attempt.attempt_id::text || '|' || p_lease_epoch::text,
              'UTF8'
            )
          )
          AND event.occurred_at = v_attempt.reconciled_at
          AND event.event_sequence = v_run.current_event_sequence
          AND event.event_sha256 = v_run.current_event_sha256
      )
    THEN
      RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
    END IF;
    RETURN ROW(
      ROW(v_run.run_id, v_run.run_revision, v_run.state,
        v_run.current_event_sequence, v_run.current_event_sha256,
        v_run.lease_epoch)::dasher_run_api.run_mutation_result,
      p_attempt_id, v_attempt.state, v_attempt.reserved_vector,
      v_attempt.used_vector, v_attempt.released_vector,
      v_attempt.outstanding_vector
    )::dasher_run_api.attempt_accounting_result;
  END IF;
  IF v_attempt.state IN ('succeeded', 'refused_charged', 'failed_charged') THEN
    SELECT result.* INTO v_stored_result
    FROM dasher.agent_recorded_results AS result
    WHERE result.organization_id = v_attempt.organization_id
      AND result.dashboard_id = v_attempt.dashboard_id
      AND result.run_id = v_attempt.run_id
      AND result.attempt_id = v_attempt.attempt_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
    END IF;
    SELECT payload.* INTO v_stored_result_payload
    FROM dasher.agent_run_attempt_payloads AS payload
    WHERE payload.organization_id = v_attempt.organization_id
      AND payload.dashboard_id = v_attempt.dashboard_id
      AND payload.run_id = v_attempt.run_id
      AND payload.attempt_id = v_attempt.attempt_id
      AND payload.payload_kind = 'result'
      AND payload.payload_id = v_attempt.result_payload_id;
    IF NOT FOUND
      OR v_attempt.actual_vector IS DISTINCT FROM v_actual
      OR v_attempt.reconciled_at IS NULL
      OR v_stored_result.canonical_bytes
        IS DISTINCT FROM p_canonical_recorded_result_bytes
      OR v_stored_result.result_sha256 IS DISTINCT FROM v_result_semantic_sha
      OR v_stored_result_payload.canonical_bytes
        IS DISTINCT FROM p_canonical_recorded_result_bytes
      OR v_stored_result_payload.payload_sha256 IS DISTINCT FROM
        pg_catalog.sha256(
          pg_catalog.convert_to('dasher.retained-payload-envelope.v1', 'UTF8')
          || pg_catalog.decode('00', 'hex')
          || pg_catalog.int4send(pg_catalog.octet_length('recorded-result-v1'))
          || pg_catalog.convert_to('recorded-result-v1', 'UTF8')
          || pg_catalog.int4send(pg_catalog.octet_length(
            v_stored_result_payload.content_nonce
          ))
          || v_stored_result_payload.content_nonce
          || pg_catalog.int4send(pg_catalog.octet_length(
            v_result_semantic_sha
          ))
          || v_result_semantic_sha
        )
      OR v_stored_result.result_kind <> v_result_kind
      OR (v_attempt.state = 'succeeded') <> (p_outcome = 'succeeded')
      OR (v_attempt.state = 'refused_charged') <> (p_outcome = 'refused')
      OR (v_attempt.state = 'failed_charged') <> (p_outcome = 'failed')
      OR v_stored_result.result_head_sha256 IS DISTINCT FROM
        pg_catalog.sha256(
          pg_catalog.convert_to('dasher.replay-result-head.v1', 'UTF8')
          || pg_catalog.decode('00', 'hex')
          || pg_catalog.uuid_send(v_stored_result.run_id)
          || pg_catalog.int8send(v_stored_result.result_sequence)
          || CASE WHEN v_stored_result.prior_result_head_sha256 IS NULL
            THEN pg_catalog.decode('00', 'hex')
            ELSE pg_catalog.decode('01', 'hex')
              || v_stored_result.prior_result_head_sha256 END
          || pg_catalog.uuid_send(v_stored_result.result_id)
          || pg_catalog.int4send(pg_catalog.octet_length(
            v_stored_result.result_kind
          ))
          || pg_catalog.convert_to(v_stored_result.result_kind, 'UTF8')
          || v_stored_result.result_sha256
        )
      OR NOT EXISTS (
        SELECT 1
        FROM dasher.agent_run_events AS event
        WHERE event.organization_id = v_attempt.organization_id
          AND event.dashboard_id = v_attempt.dashboard_id
          AND event.run_id = v_attempt.run_id
          AND event.event_kind = 'attempt_reconciled'
          AND event.occurred_at = v_attempt.reconciled_at
      )
    THEN
      RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
    END IF;
    RETURN ROW(
      ROW(v_run.run_id, v_run.run_revision, v_run.state,
        v_run.current_event_sequence, v_run.current_event_sha256,
        v_run.lease_epoch)::dasher_run_api.run_mutation_result,
      p_attempt_id, v_attempt.state, v_attempt.reserved_vector,
      v_attempt.used_vector, v_attempt.released_vector, v_attempt.outstanding_vector
    )::dasher_run_api.attempt_accounting_result;
  END IF;
  IF v_attempt.state <> 'dispatch_started' THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  IF v_indeterminate_reason IS NOT NULL THEN
    FOR v_field IN
      SELECT reserved.key AS vector_field,
        CASE WHEN reserved.key = 'candidates'
          THEN 0 ELSE reserved.value::bigint END AS used_units,
        CASE WHEN reserved.key = 'candidates'
          THEN reserved.value::bigint ELSE 0 END AS released_units
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
        AND counter.dashboard_id = v_run.dashboard_id
        AND counter.run_id = v_run.run_id
        AND counter.partition = v_attempt.partition
        AND counter.vector_field = v_field.vector_field;
    END LOOP;
    UPDATE dasher.agent_run_attempts AS attempt
    SET state = 'indeterminate_quarantined', actual_vector = NULL,
      used_vector = ROW(
        (reserved_vector).calls, 0,
        (reserved_vector).specialist_attempts,
        (reserved_vector).reviewer_attempts,
        (reserved_vector).repair_attempts,
        (reserved_vector).input_tokens, (reserved_vector).output_tokens,
        (reserved_vector).reasoning_tokens,
        (reserved_vector).cache_read_tokens,
        (reserved_vector).cache_write_tokens,
        (reserved_vector).total_tokens, (reserved_vector).wall_millis,
        (reserved_vector).work_millis, (reserved_vector).cost_micros
      )::dasher_run_api.attempt_resource_vector,
      released_vector = ROW(
        0, (reserved_vector).candidates, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0
      )::dasher_run_api.attempt_resource_vector,
      outstanding_vector = v_zero,
      result_payload_id = NULL,
      reconciled_at = pg_catalog.statement_timestamp(),
      terminal_reason_sha256 = pg_catalog.sha256(
        pg_catalog.convert_to('dasher.attempt-indeterminate-reason.v1', 'UTF8')
        || pg_catalog.decode('00', 'hex')
        || pg_catalog.convert_to(v_indeterminate_reason, 'UTF8')
      )
    WHERE attempt.organization_id = v_run.organization_id
      AND attempt.dashboard_id = v_run.dashboard_id
      AND attempt.run_id = v_run.run_id
      AND attempt.attempt_id = p_attempt_id;
    PERFORM pg_catalog.set_config('dasher.run_next_state', 'failed', true);
    PERFORM pg_catalog.set_config('dasher.run_clear_lease', 'true', true);
    v_mutation := dasher_private.append_agent_run_event_v1(
      v_run.run_id,
      dasher_private.uuid_v8_from_sha256_v1(
        pg_catalog.convert_to(
          'dasher.attempt-indeterminate-event-id.v1|' || p_attempt_id::text
            || '|' || p_lease_epoch::text,
          'UTF8'
        )
      ),
      'attempt_indeterminate',
      pg_catalog.convert_to(pg_catalog.jsonb_build_object(
        'attempt_id', p_attempt_id::text,
        'fenced_lease_epoch', 'i64:' || (v_run.lease_epoch + 1)::text,
        'reason_code', v_indeterminate_reason,
        'released_vector', pg_catalog.to_jsonb(ROW(
          0, (v_attempt.reserved_vector).candidates, 0, 0, 0, 0, 0,
          0, 0, 0, 0, 0, 0, 0
        )::dasher_run_api.attempt_resource_vector),
        'used_vector', pg_catalog.to_jsonb(ROW(
          (v_attempt.reserved_vector).calls, 0,
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
        )::dasher_run_api.attempt_resource_vector)
      )::text, 'UTF8')
    );
    RETURN ROW(
      v_mutation, p_attempt_id, 'indeterminate_quarantined',
      v_attempt.reserved_vector,
      ROW(
        (v_attempt.reserved_vector).calls, 0,
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
      ROW(
        0, (v_attempt.reserved_vector).candidates, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0
      )::dasher_run_api.attempt_resource_vector,
      v_zero
    )::dasher_run_api.attempt_accounting_result;
  END IF;
  SELECT pg_catalog.sha256(COALESCE(pg_catalog.string_agg(
      pg_catalog.uuid_send(member.evidence_id)
      || pg_catalog.uuid_send(member.source_snapshot_id)
      || member.evidence_sha256 || member.source_sha256
      || pg_catalog.int4send(pg_catalog.octet_length(member.freshness))
      || pg_catalog.convert_to(member.freshness, 'UTF8')
      || pg_catalog.int8send((pg_catalog.date_part('epoch',
          member.observed_at) * 1000000)::bigint),
      ''::bytea ORDER BY pg_catalog.uuid_send(member.evidence_id)
    ), ''::bytea)) INTO v_bundle_members_after
  FROM dasher.candidate_comparison_bundle_evidence AS member
  WHERE member.organization_id = v_bundle.organization_id
    AND member.dashboard_id = v_bundle.dashboard_id
    AND member.run_id = v_bundle.run_id
    AND member.bundle_id = v_bundle.bundle_id;
  IF v_bundle_members_after IS DISTINCT FROM v_bundle_members_before
    OR (SELECT pg_catalog.count(*)
        FROM dasher.candidate_comparison_bundle_evidence AS member
        WHERE member.organization_id = v_bundle.organization_id
          AND member.dashboard_id = v_bundle.dashboard_id
          AND member.run_id = v_bundle.run_id
          AND member.bundle_id = v_bundle.bundle_id) <> v_bundle.evidence_count
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  INSERT INTO dasher.agent_run_attempt_payloads (
    organization_id, dashboard_id, run_id, attempt_id, payload_kind,
    payload_id, content_nonce, canonical_bytes, payload_sha256, created_at
  ) VALUES (
    v_run.organization_id, v_run.dashboard_id, v_run.run_id, p_attempt_id,
    'result', v_payload_id, v_nonce, p_canonical_recorded_result_bytes,
    v_payload_sha, pg_catalog.statement_timestamp()
  );
  SELECT result.result_head_sha256 INTO v_prior_head
  FROM dasher.agent_recorded_results AS result
  WHERE result.organization_id = v_run.organization_id
    AND result.dashboard_id = v_run.dashboard_id AND result.run_id = v_run.run_id
  ORDER BY result.result_sequence DESC LIMIT 1;
  SELECT COALESCE(pg_catalog.max(result.result_sequence), 0) + 1
    INTO v_result_sequence
  FROM dasher.agent_recorded_results AS result
  WHERE result.organization_id = v_run.organization_id
    AND result.dashboard_id = v_run.dashboard_id AND result.run_id = v_run.run_id;
  IF v_result_sequence > 5 THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  v_result_head := pg_catalog.sha256(
    pg_catalog.convert_to('dasher.replay-result-head.v1', 'UTF8')
    || pg_catalog.decode('00', 'hex')
    || pg_catalog.uuid_send(v_run.run_id)
    || pg_catalog.int8send(v_result_sequence)
    || CASE WHEN v_prior_head IS NULL
      THEN pg_catalog.decode('00', 'hex')
      ELSE pg_catalog.decode('01', 'hex') || v_prior_head END
    || pg_catalog.uuid_send(v_result_id)
    || pg_catalog.int4send(pg_catalog.octet_length(v_result_kind))
    || pg_catalog.convert_to(v_result_kind, 'UTF8')
    || v_result_semantic_sha
  );
  INSERT INTO dasher.agent_recorded_results (
    organization_id, dashboard_id, run_id, result_sequence, result_id,
    attempt_id, result_payload_id, replay_source_run_id,
    replay_source_result_sequence, replay_source_result_sha256, result_kind,
    canonical_bytes, result_sha256, prior_result_head_sha256,
    result_head_sha256, created_at
  ) VALUES (
    v_run.organization_id, v_run.dashboard_id, v_run.run_id, v_result_sequence,
    v_result_id, p_attempt_id, v_payload_id, NULL, NULL, NULL, v_result_kind,
    p_canonical_recorded_result_bytes, v_result_semantic_sha, v_prior_head,
    v_result_head, pg_catalog.statement_timestamp()
  );
  FOR v_field IN
    SELECT actual.key AS vector_field, actual.value::bigint AS used_units,
      reserved.value::bigint - actual.value::bigint AS released_units
    FROM pg_catalog.jsonb_each_text(pg_catalog.to_jsonb(v_actual)) AS actual
    JOIN pg_catalog.jsonb_each_text(pg_catalog.to_jsonb(v_attempt.reserved_vector)) AS reserved
      ON reserved.key = actual.key
    ORDER BY actual.key
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
  UPDATE dasher.agent_run_attempts AS attempt
  SET state = CASE p_outcome WHEN 'succeeded' THEN 'succeeded'
      WHEN 'refused' THEN 'refused_charged' ELSE 'failed_charged' END,
    result_payload_id = v_payload_id, actual_vector = v_actual,
    used_vector = v_actual,
    released_vector = pg_catalog.jsonb_populate_record(
      NULL::dasher_run_api.attempt_resource_vector,
      (SELECT pg_catalog.jsonb_object_agg(
        actual.key, (reserved.value::bigint - actual.value::bigint)::text
      ) FROM pg_catalog.jsonb_each_text(pg_catalog.to_jsonb(v_actual)) AS actual
      JOIN pg_catalog.jsonb_each_text(pg_catalog.to_jsonb(v_attempt.reserved_vector)) AS reserved
        ON reserved.key = actual.key)
    ),
    outstanding_vector = v_zero, reconciled_at = pg_catalog.statement_timestamp(),
    terminal_reason_sha256 = CASE WHEN p_outcome = 'succeeded' THEN NULL
      ELSE pg_catalog.sha256(pg_catalog.convert_to(p_outcome, 'UTF8')) END
  WHERE attempt.organization_id = v_run.organization_id
    AND attempt.dashboard_id = v_run.dashboard_id AND attempt.run_id = v_run.run_id
    AND attempt.attempt_id = p_attempt_id;
  v_mutation := dasher_private.append_agent_run_event_v1(
    v_run.run_id, dasher_private.uuid_v8_from_sha256_v1(pg_catalog.convert_to(pg_catalog.clock_timestamp()::text || '|' || pg_catalog.txid_current()::text || '|' || pg_catalog.random()::text, 'UTF8')), 'attempt_reconciled',
    pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'attempt_id', p_attempt_id::text, 'outcome', p_outcome,
      'result_id', v_result_id::text,
      'result_sha256', pg_catalog.encode(v_result_semantic_sha, 'hex'),
      'actual_vector', pg_catalog.to_jsonb(v_actual),
      'used_vector', pg_catalog.to_jsonb(v_actual),
      'released_vector', (
        SELECT pg_catalog.jsonb_object_agg(
          actual.key,
          (reserved.value::bigint - actual.value::bigint)
          ORDER BY actual.key
        )
        FROM pg_catalog.jsonb_each_text(
          pg_catalog.to_jsonb(v_actual)
        ) AS actual
        JOIN pg_catalog.jsonb_each_text(
          pg_catalog.to_jsonb(v_attempt.reserved_vector)
        ) AS reserved ON reserved.key = actual.key
      )
    )::text, 'UTF8')
  );
  RETURN ROW(
    v_mutation, p_attempt_id,
    CASE p_outcome WHEN 'succeeded' THEN 'succeeded'
      WHEN 'refused' THEN 'refused_charged' ELSE 'failed_charged' END,
    v_attempt.reserved_vector, v_actual,
    pg_catalog.jsonb_populate_record(
      NULL::dasher_run_api.attempt_resource_vector,
      (SELECT pg_catalog.jsonb_object_agg(
        actual.key, (reserved.value::bigint - actual.value::bigint)::text
      ) FROM pg_catalog.jsonb_each_text(pg_catalog.to_jsonb(v_actual)) AS actual
      JOIN pg_catalog.jsonb_each_text(pg_catalog.to_jsonb(v_attempt.reserved_vector)) AS reserved
        ON reserved.key = actual.key)
    ), v_zero
  )::dasher_run_api.attempt_accounting_result;
END
$function$;

CREATE OR REPLACE FUNCTION dasher_run_api.commit_calculation_graph(
  p_run_id uuid,
  p_lease_epoch bigint,
  p_attempt_token bytea,
  p_graph_id uuid,
  p_canonical_graph_bytes bytea,
  p_canonical_result_bytes bytea,
  p_meter_vector dasher_run_api.calculation_meter_vector_v1,
  p_expected_input_sha256 bytea
)
RETURNS dasher_run_api.calculation_commit_result
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_run dasher.agent_runs%ROWTYPE;
  v_graph jsonb;
  v_result jsonb;
  v_meter jsonb := pg_catalog.to_jsonb(p_meter_vector);
  v_graph_sha bytea;
  v_result_sha bytea;
  v_meter_sha bytea;
  v_meter_bytes bytea;
  v_outputs_bytes bytea;
  v_result_id uuid;
  v_existing dasher.calculation_graphs%ROWTYPE;
  v_mutation dasher_run_api.run_mutation_result;
  v_request dasher.agent_run_request_payloads%ROWTYPE;
  v_request_body jsonb;
  v_catalog dasher.field_catalog_snapshots%ROWTYPE;
  v_contract dasher.metric_contract_versions%ROWTYPE;
  v_bundle dasher.candidate_comparison_bundles%ROWTYPE;
  v_contract_output jsonb;
  v_freshness_classifier_node_id uuid;
  v_freshness_input_node_id uuid;
  v_freshness_source_row_id uuid;
  v_freshness_match_count bigint;
  v_expected_max_top_k bigint;
  v_expected_max_window_frame bigint;
  v_expected_scanned_rows bigint;
BEGIN
  IF p_graph_id IS NULL OR pg_catalog.octet_length(p_expected_input_sha256) <> 32
    OR p_canonical_graph_bytes IS NULL
    OR pg_catalog.octet_length(p_canonical_graph_bytes) NOT BETWEEN 1 AND 65536
    OR p_canonical_result_bytes IS NULL
    OR pg_catalog.octet_length(p_canonical_result_bytes) NOT BETWEEN 1 AND 1114112
    OR EXISTS (
      SELECT 1 FROM pg_catalog.jsonb_each_text(v_meter) AS item
      WHERE item.value::bigint < 0
    )
    OR (p_meter_vector).input_bytes > 1048576
    OR (p_meter_vector).ast_bytes > 65536
    OR (p_meter_vector).node_count > 128
    OR (p_meter_vector).max_depth > 32
    OR (p_meter_vector).max_literal_bytes > 4096
    OR (p_meter_vector).total_literal_bytes > 32768
    OR (p_meter_vector).max_literal_list_length > 256
    OR (p_meter_vector).scanned_rows > 10000
    OR (p_meter_vector).group_count > 1000
    OR (p_meter_vector).max_group_rows > 10000
    OR (p_meter_vector).cumulative_intermediate_rows > 50000
    OR (p_meter_vector).final_output_rows > 2000
    OR (p_meter_vector).cumulative_intermediate_bytes > 8388608
    OR (p_meter_vector).output_bytes > 1048576
    OR (p_meter_vector).primitive_steps > 1000000
    OR (p_meter_vector).logical_allocation_bytes > 33554432
    OR (p_meter_vector).max_top_k > 1000
    OR (p_meter_vector).max_window_frame > 10000
    OR (p_meter_vector).max_coefficient_digits > 38
    OR (p_meter_vector).max_scale > 18
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_calculation_limit';
  END IF;
  BEGIN
    v_graph := pg_catalog.convert_from(p_canonical_graph_bytes, 'UTF8')::jsonb;
    v_result := pg_catalog.convert_from(p_canonical_result_bytes, 'UTF8')::jsonb;
  EXCEPTION WHEN character_not_in_repertoire OR invalid_text_representation THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END;
  IF NOT dasher_private.validate_metric_contract_graph_v1(
      p_canonical_graph_bytes, p_canonical_result_bytes
    )
    OR v_graph->>'schema' <> 'calculation-graph-v1'
    OR v_result->>'schema' <> 'calculation-result-v1'
    OR v_result->>'state' <> 'succeeded'
    OR (v_graph->>'graph_id')::uuid <> p_graph_id
    OR (v_result->>'graph_id')::uuid <> p_graph_id
    OR pg_catalog.jsonb_typeof(v_graph->'nodes') <> 'array'
    OR pg_catalog.jsonb_array_length(v_graph->'nodes') <> (p_meter_vector).node_count
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  v_result_id := (v_result->>'result_id')::uuid;
  PERFORM dasher_private.initialize_run_operator_context_v1(p_run_id, 'commit_graph');
  PERFORM dasher_private.reauthorize_agent_run_v1(p_run_id, p_lease_epoch, p_attempt_token);
  IF NULLIF(current_setting(
    'dasher.run_replay_source_id', true
  ), '') IS NOT NULL THEN
    PERFORM dasher_private.replay_source_fence_v1(
      NULLIF(current_setting('dasher.run_organization_id', true), '')::uuid,
      NULLIF(current_setting('dasher.run_replay_source_id', true), '')::uuid
    );
    PERFORM pg_catalog.set_config('dasher.run_phase', 'authorized', true);
  END IF;
  SELECT run.* INTO STRICT v_run FROM dasher.agent_runs AS run
  WHERE run.organization_id = current_setting('dasher.run_organization_id', true)::uuid
    AND run.run_id = p_run_id FOR UPDATE;
  IF v_run.state NOT IN ('generating', 'revising', 'validating') THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  SELECT request_payload.* INTO STRICT v_request
  FROM dasher.agent_run_request_payloads AS request_payload
  WHERE request_payload.organization_id = v_run.organization_id
    AND request_payload.dashboard_id = v_run.dashboard_id
    AND request_payload.request_payload_id = v_run.request_payload_id;
  v_request_body := pg_catalog.convert_from(v_request.canonical_bytes, 'UTF8')::jsonb;
  IF NOT dasher_private.evaluate_calculation_graph_v1(
      p_canonical_graph_bytes,
      p_canonical_result_bytes,
      dasher_private.canonical_jsonb_bytes_v1(v_request_body->'input_table'),
      p_meter_vector
    )
    OR v_graph->>'evaluation_time' <> pg_catalog.to_char(
      v_run.requested_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    )
    OR v_graph->>'input_sha256' <> pg_catalog.encode(
      p_expected_input_sha256, 'hex'
    )
    OR pg_catalog.convert_from(v_request.canonical_bytes, 'UTF8')::jsonb
      ->>'input_snapshot_id' <> v_graph->>'input_snapshot_id'
    OR pg_catalog.convert_from(v_request.canonical_bytes, 'UTF8')::jsonb
      ->>'field_catalog' IS NULL
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  SELECT catalog.* INTO STRICT v_catalog
  FROM dasher.field_catalog_snapshots AS catalog
  JOIN dasher.source_snapshots AS source
    ON source.organization_id = catalog.organization_id
   AND source.snapshot_id = catalog.input_snapshot_id
  WHERE catalog.organization_id = v_run.organization_id
    AND catalog.dashboard_id = v_run.dashboard_id
    AND catalog.catalog_snapshot_id = (
      v_graph->>'field_catalog_snapshot_id'
    )::uuid
    AND catalog.input_sha256 = p_expected_input_sha256
    AND catalog.catalog_sha256 = pg_catalog.decode(
      v_graph->>'field_catalog_sha256', 'hex'
    )
    AND source.snapshot_id = (v_graph->>'input_snapshot_id')::uuid
    AND source.content_sha256 = p_expected_input_sha256
    AND v_graph->>'input_sha256' = pg_catalog.encode(
      p_expected_input_sha256, 'hex'
    )
    AND (p_meter_vector).input_bytes = pg_catalog.octet_length(
      source.canonical_bytes
    );
  SELECT contract.* INTO STRICT v_contract
  FROM dasher.metric_contract_versions AS contract
  WHERE contract.organization_id = v_run.organization_id
    AND contract.dashboard_id = v_run.dashboard_id
    AND contract.contract_set_id = (v_graph->>'contract_set_id')::uuid
    AND contract.contract_id = (v_graph->>'contract_id')::uuid
    AND contract.contract_version = pg_catalog.substr(
      v_graph->>'contract_version', 5
    )::bigint
    AND contract.catalog_snapshot_id = (
      v_graph->>'field_catalog_snapshot_id'
    )::uuid;
  SELECT bundle.* INTO STRICT v_bundle
  FROM dasher.candidate_comparison_bundles AS bundle
  WHERE bundle.organization_id = v_run.organization_id
    AND bundle.dashboard_id = v_run.dashboard_id AND bundle.run_id = v_run.run_id
    AND bundle.bundle_id = (v_graph->>'common_bundle_id')::uuid
    AND bundle.bundle_sha256 = pg_catalog.decode(
      v_graph->>'common_bundle_sha256', 'hex'
    )
  FOR UPDATE;
  SELECT node.value INTO STRICT v_contract_output
  FROM pg_catalog.jsonb_array_elements(v_graph->'nodes') AS node(value)
  WHERE node.value->>'node_id' = v_graph->>'contract_output_node_id';
  IF v_catalog.catalog_sha256 <> pg_catalog.decode(
      v_graph->>'field_catalog_sha256', 'hex'
    )
    OR v_catalog.catalog_snapshot_id <> (
      v_graph->>'field_catalog_snapshot_id'
    )::uuid
    OR v_catalog.input_snapshot_id <> (v_graph->>'input_snapshot_id')::uuid
    OR v_catalog.input_sha256 <> pg_catalog.decode(
      v_graph->>'input_sha256', 'hex'
    )
    OR v_contract.contract_set_id <> (v_graph->>'contract_set_id')::uuid
    OR v_contract.contract_id <> (v_graph->>'contract_id')::uuid
    OR v_contract.contract_version <> pg_catalog.substr(
      v_graph->>'contract_version', 5
    )::bigint
    OR v_contract.review_state <> 'reviewed'
    OR v_contract.timezone <> v_graph->>'timezone'
    OR (v_contract.value_type = 'integer'
      AND v_contract_output->'output_type'->>'scalar' <> 'integer')
    OR (v_contract.value_type <> 'integer'
      AND v_contract_output->'output_type'->>'scalar' <> 'decimal')
    OR v_contract_output->'output_type'->>'unit'
      IS DISTINCT FROM v_contract.unit
    OR v_contract_output->'output_type'->>'currency'
      IS DISTINCT FROM v_contract.currency
    OR v_contract_output->'output_type'->>'grain' <> v_contract.grain
    OR (v_contract.value_type = 'integer'
      AND v_contract_output->'output_type'->>'max_value_bytes' <> 'i64:26')
    OR (v_contract.value_type <> 'integer'
      AND v_contract_output->'output_type'->>'max_value_bytes' <> 'i64:74')
    OR (v_contract.direction = 'neutral' AND (
      v_graph->'threshold_node_id' <> 'null'::jsonb
      OR v_graph->'target_node_id' <> 'null'::jsonb
    ))
    OR (v_contract.direction <> 'neutral' AND (
      v_graph->'threshold_node_id' = 'null'::jsonb
      OR v_graph->'target_node_id' = 'null'::jsonb
      OR v_graph->>'threshold_node_id' = v_graph->>'target_node_id'
    ))
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.jsonb_array_elements(v_graph->'nodes') AS node(value)
      CROSS JOIN LATERAL pg_catalog.jsonb_array_elements_text(
        CASE WHEN node.value->>'op' = 'source'
          THEN node.value->'field_ids' ELSE '[]'::jsonb END
      ) AS source_field(field_id)
      WHERE NOT EXISTS (
        SELECT 1
        FROM dasher.field_catalog_entries AS field
        WHERE field.organization_id = v_run.organization_id
          AND field.dashboard_id = v_run.dashboard_id
          AND field.catalog_snapshot_id = v_catalog.catalog_snapshot_id
          AND field.field_id = source_field.field_id::uuid
      )
    )
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.jsonb_array_elements(v_graph->'nodes') AS node(value)
      LEFT JOIN dasher.field_catalog_entries AS field
        ON field.organization_id = v_run.organization_id
       AND field.dashboard_id = v_run.dashboard_id
       AND field.catalog_snapshot_id = v_catalog.catalog_snapshot_id
       AND field.field_id = (node.value->>'field_id')::uuid
      WHERE node.value->>'op' = 'field'
        AND (field.field_id IS NULL
          OR node.value->'output_type'->>'scalar' <> field.scalar_type
          OR (node.value->'output_type'->>'nullable')::boolean <> field.nullable
          OR node.value->'output_type'->>'unit' IS DISTINCT FROM field.unit
          OR node.value->'output_type'->>'currency' IS DISTINCT FROM field.currency
          OR node.value->'output_type'->>'grain' IS DISTINCT FROM field.grain
          OR node.value->'output_type'->>'max_value_bytes'
            <> 'i64:' || field.max_value_bytes::text)
    )
    OR EXISTS (
      SELECT lineage.evidence_id
      FROM pg_catalog.unnest(v_contract.lineage_evidence_ids)
        AS lineage(evidence_id)
      WHERE NOT EXISTS (
        SELECT 1
        FROM dasher.candidate_comparison_bundle_evidence AS member
        WHERE member.organization_id = v_run.organization_id
          AND member.dashboard_id = v_run.dashboard_id
          AND member.run_id = v_run.run_id
          AND member.bundle_id = v_bundle.bundle_id
          AND member.evidence_id = lineage.evidence_id
          AND member.source_snapshot_id = v_catalog.input_snapshot_id
          AND member.freshness = 'current'
      )
    )
    OR (v_graph->'fx_evidence_id' <> 'null'::jsonb AND NOT EXISTS (
      SELECT 1
      FROM dasher.candidate_comparison_bundle_evidence AS member
      WHERE member.organization_id = v_run.organization_id
        AND member.dashboard_id = v_run.dashboard_id
        AND member.run_id = v_run.run_id
        AND member.bundle_id = v_bundle.bundle_id
        AND member.evidence_id = (v_graph->>'fx_evidence_id')::uuid
        AND member.evidence_sha256 = pg_catalog.decode(
          v_graph->>'fx_evidence_sha256', 'hex'
        )
        AND member.freshness = 'current'
    ))
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  SELECT pg_catalog.count(*),
      pg_catalog.min(classifier.value->>'node_id')::uuid,
      pg_catalog.min(maximum.value->>'node_id')::uuid
    INTO v_freshness_match_count, v_freshness_classifier_node_id,
      v_freshness_input_node_id
  FROM pg_catalog.jsonb_array_elements(v_graph->'nodes') AS classifier(value)
  JOIN pg_catalog.jsonb_array_elements(v_graph->'nodes') AS maximum(value)
    ON maximum.value->>'node_id' = classifier.value->>'input'
   AND maximum.value->>'op' = 'max'
  JOIN pg_catalog.jsonb_array_elements(v_graph->'nodes') AS event_field(value)
    ON event_field.value->>'node_id' = maximum.value->>'input'
   AND event_field.value->>'op' = 'field'
  JOIN dasher.field_catalog_entries AS measure
    ON measure.organization_id = v_run.organization_id
   AND measure.dashboard_id = v_run.dashboard_id
   AND measure.catalog_snapshot_id = v_catalog.catalog_snapshot_id
   AND measure.field_id = v_contract.measure_field_id
   AND event_field.value->>'field_id' = measure.event_time_field_id::text
  JOIN pg_catalog.jsonb_array_elements(v_graph->'nodes') AS freshness_group(value)
    ON freshness_group.value->>'node_id' = maximum.value->>'group_node_id'
   AND freshness_group.value->>'op' = 'group'
   AND freshness_group.value->'key_node_ids' = '[]'::jsonb
   AND freshness_group.value->>'input' = event_field.value->>'input'
  WHERE classifier.value->>'op' = 'classify_state'
    AND classifier.value->>'evaluation_time' = v_graph->>'evaluation_time'
    AND classifier.value->>'stale_after_millis' = 'i64:'
      || (v_contract.lag_millis + v_contract.freshness_slo_millis)::text
    AND v_graph->'output_node_ids' ? (classifier.value->>'node_id');
  IF v_freshness_match_count > 1
    OR (v_freshness_match_count = 0 AND EXISTS (
      SELECT 1
      FROM pg_catalog.jsonb_array_elements(v_graph->'nodes') AS node(value)
      WHERE node.value->>'op' = 'classify_state'
        AND node.value->>'input' IN (
          SELECT candidate.value->>'node_id'
          FROM pg_catalog.jsonb_array_elements(v_graph->'nodes') AS candidate(value)
          WHERE candidate.value->>'op' = 'max'
        )
    ))
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  IF v_freshness_match_count = 1 THEN
    SELECT (input_row.value->>'row_id')::uuid
      INTO STRICT v_freshness_source_row_id
    FROM LATERAL (
      SELECT field_node.value
      FROM pg_catalog.jsonb_array_elements(v_graph->'nodes') AS field_node(value)
      WHERE field_node.value->>'node_id' = (
        SELECT maximum.value->>'input'
        FROM pg_catalog.jsonb_array_elements(v_graph->'nodes') AS maximum(value)
        WHERE maximum.value->>'node_id' = v_freshness_input_node_id::text
      )
    ) AS event_field
    CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(
      v_request_body->'input_table'->'rows'
    ) WITH ORDINALITY AS input_row(value, ordinal)
    JOIN LATERAL pg_catalog.jsonb_array_elements(input_row.value->'values')
      AS input_value(value)
      ON input_value.value->>'field_id' = event_field.value->>'field_id'
    WHERE input_value.value->>'state' = 'present'
    ORDER BY (input_value.value->>'value')::timestamptz DESC,
      input_row.ordinal
    LIMIT 1;
  END IF;
  v_graph_sha := pg_catalog.sha256(
    pg_catalog.convert_to('dasher.calculation-graph.v1', 'UTF8')
    || pg_catalog.decode('00', 'hex')
    || pg_catalog.int4send(pg_catalog.octet_length(p_canonical_graph_bytes))
    || p_canonical_graph_bytes
  );
  v_result_sha := pg_catalog.sha256(
    pg_catalog.convert_to('dasher.calculation-result.v1', 'UTF8')
    || pg_catalog.decode('00', 'hex')
    || pg_catalog.int4send(pg_catalog.octet_length(p_canonical_result_bytes))
    || p_canonical_result_bytes
  );
  v_outputs_bytes := dasher_private.canonical_jsonb_bytes_v1(
    v_result->'outputs'
  );
  SELECT COALESCE(pg_catalog.max(
      pg_catalog.substr(node.value->>'k', 5)::bigint
    ), 0)
    INTO v_expected_max_top_k
  FROM pg_catalog.jsonb_array_elements(v_graph->'nodes') AS node(value)
  WHERE node.value->>'op' = 'top_k';
  SELECT COALESCE(pg_catalog.max(
      1 + pg_catalog.substr(node.value->>'preceding', 5)::bigint
        + pg_catalog.substr(node.value->>'following', 5)::bigint
    ), 0)
    INTO v_expected_max_window_frame
  FROM pg_catalog.jsonb_array_elements(v_graph->'nodes') AS node(value)
  WHERE node.value->>'op' IN ('window_sum','window_mean');
  SELECT pg_catalog.jsonb_array_length(
      v_request_body->'input_table'->'rows'
    ) * pg_catalog.count(*)
    INTO v_expected_scanned_rows
  FROM pg_catalog.jsonb_array_elements(v_graph->'nodes') AS node(value)
  WHERE node.value->>'op' = 'source';
  IF (p_meter_vector).ast_bytes <> pg_catalog.octet_length(
      p_canonical_graph_bytes
    )
    OR (p_meter_vector).output_bytes <>
      pg_catalog.octet_length(v_outputs_bytes)
    OR (p_meter_vector).node_count < 1
    OR (p_meter_vector).max_literal_list_length <> 0
    OR (p_meter_vector).max_top_k <> v_expected_max_top_k
    OR (p_meter_vector).max_window_frame <> v_expected_max_window_frame
    OR (p_meter_vector).scanned_rows <> v_expected_scanned_rows
    OR (p_meter_vector).logical_allocation_bytes <>
      (p_meter_vector).input_bytes
      + (p_meter_vector).ast_bytes
      + (p_meter_vector).cumulative_intermediate_bytes
      + (p_meter_vector).output_bytes
      + 64 * (p_meter_vector).node_count
    OR (p_meter_vector).final_output_rows <> (
      SELECT COALESCE(pg_catalog.sum(CASE
        WHEN pg_catalog.jsonb_typeof(output.value->'rows') = 'array'
          THEN pg_catalog.jsonb_array_length(output.value->'rows')
        ELSE 1 END), 0)
      FROM pg_catalog.jsonb_array_elements(v_result->'outputs') AS output(value)
    )
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  v_meter_bytes := dasher_private.canonical_jsonb_bytes_v1(
    pg_catalog.jsonb_build_object(
      'schema', 'calculation-meter-v1',
      'graph_id', p_graph_id::text,
      'result_id', v_result_id::text,
      'input_bytes', 'i64:' || (p_meter_vector).input_bytes::text,
      'ast_bytes', 'i64:' || (p_meter_vector).ast_bytes::text,
      'node_count', 'i64:' || (p_meter_vector).node_count::text,
      'max_depth', 'i64:' || (p_meter_vector).max_depth::text,
      'max_literal_bytes', 'i64:' || (p_meter_vector).max_literal_bytes::text,
      'total_literal_bytes', 'i64:' || (p_meter_vector).total_literal_bytes::text,
      'max_literal_list_length', 'i64:' || (p_meter_vector).max_literal_list_length::text,
      'scanned_rows', 'i64:' || (p_meter_vector).scanned_rows::text,
      'group_count', 'i64:' || (p_meter_vector).group_count::text,
      'max_group_rows', 'i64:' || (p_meter_vector).max_group_rows::text,
      'cumulative_intermediate_rows', 'i64:' || (p_meter_vector).cumulative_intermediate_rows::text,
      'final_output_rows', 'i64:' || (p_meter_vector).final_output_rows::text,
      'cumulative_intermediate_bytes', 'i64:' || (p_meter_vector).cumulative_intermediate_bytes::text,
      'output_bytes', 'i64:' || (p_meter_vector).output_bytes::text,
      'primitive_steps', 'i64:' || (p_meter_vector).primitive_steps::text,
      'logical_allocation_bytes', 'i64:' || (p_meter_vector).logical_allocation_bytes::text,
      'max_top_k', 'i64:' || (p_meter_vector).max_top_k::text,
      'max_window_frame', 'i64:' || (p_meter_vector).max_window_frame::text,
      'max_coefficient_digits', 'i64:' || (p_meter_vector).max_coefficient_digits::text,
      'max_scale', 'i64:' || (p_meter_vector).max_scale::text
    ));
  v_meter_sha := pg_catalog.sha256(
    pg_catalog.convert_to('dasher.calculation-meter.v1', 'UTF8')
    || pg_catalog.decode('00', 'hex')
    || pg_catalog.int4send(pg_catalog.octet_length(v_meter_bytes))
    || v_meter_bytes
  );
  IF v_result->>'meter_sha256' <> pg_catalog.encode(v_meter_sha, 'hex') THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  SELECT graph.* INTO v_existing FROM dasher.calculation_graphs AS graph
  WHERE graph.organization_id = v_run.organization_id
    AND graph.dashboard_id = v_run.dashboard_id AND graph.run_id = v_run.run_id
    AND graph.graph_id = p_graph_id;
  IF FOUND THEN
    IF v_existing.graph_sha256 <> v_graph_sha THEN
      RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
    END IF;
    RETURN ROW(
      ROW(v_run.run_id, v_run.run_revision, v_run.state,
        v_run.current_event_sequence, v_run.current_event_sha256,
        v_run.lease_epoch)::dasher_run_api.run_mutation_result,
      p_graph_id, v_result_id, v_graph_sha, v_result_sha, p_meter_vector
    )::dasher_run_api.calculation_commit_result;
  END IF;
  INSERT INTO dasher.calculation_graphs (
    organization_id, dashboard_id, run_id, graph_id, contract_set_id,
    contract_id, contract_version, catalog_snapshot_id, common_bundle_id,
    freshness_classifier_node_id, freshness_input_node_id,
    freshness_source_row_id, graph_sha256, canonical_bytes, created_at
  ) VALUES (
    v_run.organization_id, v_run.dashboard_id, v_run.run_id, p_graph_id,
    (v_graph->>'contract_set_id')::uuid, (v_graph->>'contract_id')::uuid,
    pg_catalog.substr(v_graph->>'contract_version', 5)::bigint,
    (v_graph->>'field_catalog_snapshot_id')::uuid,
    (v_graph->>'common_bundle_id')::uuid,
    v_freshness_classifier_node_id, v_freshness_input_node_id,
    v_freshness_source_row_id,
    v_graph_sha, p_canonical_graph_bytes, pg_catalog.statement_timestamp()
  );
  INSERT INTO dasher.calculation_results (
    organization_id, dashboard_id, run_id, result_id, graph_id,
    result_sha256, meter_sha256, canonical_bytes, created_at
  ) VALUES (
    v_run.organization_id, v_run.dashboard_id, v_run.run_id, v_result_id,
    p_graph_id, v_result_sha, v_meter_sha, p_canonical_result_bytes,
    pg_catalog.statement_timestamp()
  );
  INSERT INTO dasher.agent_run_calculation_meters (
    organization_id, dashboard_id, run_id, meter_id, graph_id, result_id,
    meter_vector, meter_sha256, created_at
  ) VALUES (
    v_run.organization_id, v_run.dashboard_id, v_run.run_id,
    dasher_private.uuid_v8_from_sha256_v1(pg_catalog.convert_to(pg_catalog.clock_timestamp()::text || '|' || pg_catalog.txid_current()::text || '|' || pg_catalog.random()::text, 'UTF8')), p_graph_id, v_result_id, p_meter_vector,
    v_meter_sha, pg_catalog.statement_timestamp()
  );
  v_mutation := dasher_private.append_agent_run_event_v1(
    v_run.run_id, dasher_private.uuid_v8_from_sha256_v1(pg_catalog.convert_to(pg_catalog.clock_timestamp()::text || '|' || pg_catalog.txid_current()::text || '|' || pg_catalog.random()::text, 'UTF8')), 'calculation_graph_committed',
    pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'graph_id', p_graph_id::text,
      'graph_sha256', pg_catalog.encode(v_graph_sha, 'hex'),
      'result_id', v_result_id::text,
      'result_sha256', pg_catalog.encode(v_result_sha, 'hex'),
      'meter_sha256', pg_catalog.encode(v_meter_sha, 'hex')
    )::text, 'UTF8')
  );
  RETURN ROW(v_mutation, p_graph_id, v_result_id, v_graph_sha,
    v_result_sha, p_meter_vector)::dasher_run_api.calculation_commit_result;
END
$function$;

CREATE OR REPLACE FUNCTION dasher_run_api.commit_agent_candidate(
  p_run_id uuid,
  p_lease_epoch bigint,
  p_attempt_token bytea,
  p_candidate_id uuid,
  p_canonical_dashboard_spec_bytes bytea,
  p_common_bundle_sha256 bytea,
  p_source_result_id uuid,
  p_source_result_sha256 bytea,
  p_precommit_validation_sha256 bytea
)
RETURNS dasher_run_api.content_commit_result
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_run dasher.agent_runs%ROWTYPE;
  v_body jsonb;
  v_sha bytea;
  v_brief dasher.briefs%ROWTYPE;
  v_bundle dasher.candidate_comparison_bundles%ROWTYPE;
  v_source_result dasher.agent_recorded_results%ROWTYPE;
  v_source_payload dasher.agent_run_attempt_payloads%ROWTYPE;
  v_source_attempt dasher.agent_run_attempts%ROWTYPE;
  v_source_request_payload dasher.agent_run_attempt_payloads%ROWTYPE;
  v_source_body jsonb;
  v_source_request jsonb;
  v_nested_spec_bytes bytea;
  v_precommit jsonb;
  v_precommit_bytes bytea;
  v_precommit_sha bytea;
  v_validator_source_sha bytea;
  v_request_payload dasher.agent_run_request_payloads%ROWTYPE;
  v_request_body jsonb;
  v_assertions jsonb;
  v_claim_count bigint;
  v_claim_set_sha bytea;
  v_existing dasher.agent_candidates%ROWTYPE;
  v_existing_payload dasher.agent_candidate_payloads%ROWTYPE;
  v_mutation dasher_run_api.run_mutation_result;
  v_replay boolean := false;
  v_receipt_sha bytea;
BEGIN
  PERFORM pg_catalog.set_config(
    'dasher.run_replay_candidate_receipt_sha256', '', true
  );
  IF p_candidate_id IS NULL
    OR pg_catalog.octet_length(p_common_bundle_sha256) <> 32
    OR pg_catalog.octet_length(p_source_result_sha256) <> 32
    OR pg_catalog.octet_length(p_precommit_validation_sha256) <> 32
    OR p_canonical_dashboard_spec_bytes IS NULL
    OR pg_catalog.octet_length(p_canonical_dashboard_spec_bytes) NOT BETWEEN 1 AND 1048576
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  BEGIN
    v_body := pg_catalog.convert_from(p_canonical_dashboard_spec_bytes, 'UTF8')::jsonb;
  EXCEPTION WHEN character_not_in_repertoire OR invalid_text_representation THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END;
  IF dasher_private.validate_dashboard_spec_v1(
      p_canonical_dashboard_spec_bytes
    ) IS DISTINCT FROM true
    OR v_body->>'dataMode' <> 'demo'
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  v_sha := pg_catalog.sha256(
    pg_catalog.convert_to('dasher.dashboard-spec.v1', 'UTF8')
    || pg_catalog.decode('00', 'hex')
    || pg_catalog.int4send(pg_catalog.octet_length(p_canonical_dashboard_spec_bytes))
    || p_canonical_dashboard_spec_bytes
  );
  v_assertions := dasher_private.extract_material_assertions_v1(
    p_canonical_dashboard_spec_bytes, v_sha
  );
  v_claim_count := pg_catalog.jsonb_array_length(v_assertions);
  v_claim_set_sha := dasher_private.material_claim_set_sha256_v1(
    v_sha, v_assertions
  );
  IF v_claim_count NOT BETWEEN 1 AND 64 OR v_claim_set_sha IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  PERFORM dasher_private.initialize_run_operator_context_v1(p_run_id, 'commit_candidate');
  PERFORM dasher_private.reauthorize_agent_run_v1(p_run_id, p_lease_epoch, p_attempt_token);
  IF NULLIF(current_setting(
    'dasher.run_replay_source_id', true
  ), '') IS NOT NULL THEN
    PERFORM dasher_private.replay_source_fence_v1(
      NULLIF(current_setting('dasher.run_organization_id', true), '')::uuid,
      NULLIF(current_setting('dasher.run_replay_source_id', true), '')::uuid
    );
    PERFORM pg_catalog.set_config('dasher.run_phase', 'authorized', true);
  END IF;
  v_replay := NULLIF(current_setting(
    'dasher.run_replay_source_id', true
  ), '') IS NOT NULL;
  SELECT run.* INTO STRICT v_run FROM dasher.agent_runs AS run
  WHERE run.organization_id = current_setting('dasher.run_organization_id', true)::uuid
    AND run.run_id = p_run_id FOR UPDATE;
  SELECT payload.* INTO STRICT v_request_payload
  FROM dasher.agent_run_request_payloads AS payload
  WHERE payload.organization_id = v_run.organization_id
    AND payload.dashboard_id = v_run.dashboard_id
    AND payload.request_payload_id = v_run.request_payload_id;
  v_request_body := pg_catalog.convert_from(
    v_request_payload.canonical_bytes, 'UTF8'
  )::jsonb;
  IF dasher_private.canonical_jsonb_bytes_v1(v_request_body)
      IS DISTINCT FROM v_request_payload.canonical_bytes
    OR (NOT v_replay AND v_body->>'generatedAt' <> v_request_body->>'evaluation_time')
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  SELECT bundle.* INTO STRICT v_bundle
  FROM dasher.candidate_comparison_bundles AS bundle
  WHERE bundle.organization_id = v_run.organization_id
    AND bundle.dashboard_id = v_run.dashboard_id
    AND bundle.run_id = v_run.run_id
    AND bundle.bundle_sha256 = p_common_bundle_sha256
  FOR UPDATE;
  SELECT brief.* INTO STRICT v_brief
  FROM dasher.briefs AS brief
  WHERE brief.organization_id = v_run.organization_id
    AND brief.dashboard_id = v_run.dashboard_id
    AND brief.run_id = v_run.run_id
    AND brief.common_bundle_id = v_bundle.bundle_id;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(v_body->'evidence') AS evidence(value)
    WHERE evidence.value->>'id' !~
        '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      OR NOT EXISTS (
        SELECT 1
        FROM dasher.candidate_comparison_bundle_evidence AS member
        WHERE member.organization_id = v_run.organization_id
          AND member.dashboard_id = v_run.dashboard_id
          AND member.run_id = v_run.run_id
          AND member.bundle_id = v_bundle.bundle_id
          AND member.evidence_id = (evidence.value->>'id')::uuid
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  SELECT result.* INTO STRICT v_source_result
  FROM dasher.agent_recorded_results AS result
  WHERE result.organization_id = v_run.organization_id
    AND result.dashboard_id = v_run.dashboard_id
    AND result.run_id = v_run.run_id
    AND result.result_id = p_source_result_id
    AND result.result_sha256 = p_source_result_sha256
    AND result.result_kind IN ('candidate_output', 'repair_output')
    AND (CASE WHEN v_replay
      THEN result.attempt_id IS NULL
        AND result.result_payload_id IS NULL
        AND result.replay_source_run_id IS NOT NULL
        AND result.replay_source_result_sequence IS NOT NULL
        AND result.replay_source_result_sha256 IS NOT NULL
      ELSE result.attempt_id IS NOT NULL
        AND result.result_payload_id IS NOT NULL
      END);
  IF NOT v_replay THEN
    SELECT attempt.* INTO STRICT v_source_attempt
    FROM dasher.agent_run_attempts AS attempt
    WHERE attempt.organization_id = v_run.organization_id
      AND attempt.dashboard_id = v_run.dashboard_id
      AND attempt.run_id = v_run.run_id
      AND attempt.attempt_id = v_source_result.attempt_id
      AND attempt.state = 'succeeded'
      AND ((attempt.attempt_kind = 'generator'
            AND v_source_result.result_kind = 'candidate_output')
        OR (attempt.attempt_kind = 'repair'
            AND v_source_result.result_kind = 'repair_output'))
    FOR UPDATE;
    SELECT payload.* INTO STRICT v_source_payload
    FROM dasher.agent_run_attempt_payloads AS payload
    WHERE payload.organization_id = v_run.organization_id
      AND payload.dashboard_id = v_run.dashboard_id
      AND payload.run_id = v_run.run_id
      AND payload.attempt_id = v_source_attempt.attempt_id
      AND payload.payload_kind = 'result'
      AND payload.payload_id = v_source_result.result_payload_id;
    SELECT payload.* INTO STRICT v_source_request_payload
    FROM dasher.agent_run_attempt_payloads AS payload
    WHERE payload.organization_id = v_run.organization_id
      AND payload.dashboard_id = v_run.dashboard_id
      AND payload.run_id = v_run.run_id
      AND payload.attempt_id = v_source_attempt.attempt_id
      AND payload.payload_kind = 'request'
      AND payload.payload_id = v_source_attempt.request_payload_id;
    v_source_request := pg_catalog.convert_from(
      v_source_request_payload.canonical_bytes, 'UTF8'
    )::jsonb;
    IF v_source_result.canonical_bytes <> v_source_payload.canonical_bytes
      OR v_source_payload.payload_sha256 <> pg_catalog.sha256(
        pg_catalog.convert_to('dasher.retained-payload-envelope.v1', 'UTF8')
        || pg_catalog.decode('00', 'hex')
        || pg_catalog.int4send(pg_catalog.octet_length('recorded-result-v1'))
        || pg_catalog.convert_to('recorded-result-v1', 'UTF8')
        || pg_catalog.int4send(pg_catalog.octet_length(
          v_source_payload.content_nonce
        )) || v_source_payload.content_nonce
        || pg_catalog.int4send(pg_catalog.octet_length(
          v_source_result.result_sha256
        )) || v_source_result.result_sha256
      )
      OR v_source_request->>'common_bundle_sha256' <>
        pg_catalog.encode(v_bundle.bundle_sha256, 'hex')
      OR v_source_request->>'brief_sha256' <>
        pg_catalog.encode(v_brief.brief_sha256, 'hex')
    THEN
      RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
    END IF;
  ELSE
    -- Consumed Replay results carry no local attempt or payload by table
    -- CHECK; the request-pinned source lineage replaces those reads.
    IF v_request_body->>'purpose' <> 'replay'
      OR v_request_body->>'replay_source_run_id' <>
        v_source_result.replay_source_run_id::text
      OR NULLIF(current_setting('dasher.run_replay_source_id', true), '')
        IS DISTINCT FROM v_source_result.replay_source_run_id::text
      OR v_request_body->>'replay_source_selected_candidate_id' <>
        p_candidate_id::text
      OR v_request_body->>'replay_source_bundle_id' <> v_bundle.bundle_id::text
      OR v_request_body->>'replay_source_bundle_sha256' <>
        pg_catalog.encode(v_bundle.bundle_sha256, 'hex')
      OR v_request_body->>'replay_source_brief_id' <> v_brief.brief_id::text
      OR v_request_body->>'replay_source_brief_sha256' <>
        pg_catalog.encode(v_brief.brief_sha256, 'hex')
      OR v_source_result.replay_source_result_sequence NOT BETWEEN 1 AND 5
      OR pg_catalog.substring(
        v_request_body->>'replay_source_result_count', '^i64:([3-5])$'
      ) IS NULL
      OR v_source_result.replay_source_result_sequence > pg_catalog.substring(
        v_request_body->>'replay_source_result_count', '^i64:([3-5])$'
      )::bigint
      OR v_source_result.replay_source_result_sha256 <>
        v_source_result.result_sha256
      OR v_source_result.result_id <> p_source_result_id
      OR v_source_result.result_sha256 <> p_source_result_sha256
    THEN
      RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
    END IF;
  END IF;
  v_source_body := pg_catalog.convert_from(
    v_source_result.canonical_bytes, 'UTF8'
  )::jsonb;
  v_nested_spec_bytes := dasher_private.canonical_dashboard_jsonb_bytes_v1(
    v_source_body#>'{result,dashboard_spec}'
  );
  v_precommit := v_source_body#>'{result,precommit_validation}';
  v_precommit_bytes := dasher_private.canonical_jsonb_bytes_v1(v_precommit);
  v_precommit_sha := pg_catalog.sha256(
    pg_catalog.convert_to('dasher.precommit-dashboard-validation.v1', 'UTF8')
    || pg_catalog.decode('00', 'hex')
    || pg_catalog.int4send(pg_catalog.octet_length(v_precommit_bytes))
    || v_precommit_bytes
  );
  v_validator_source_sha := pg_catalog.sha256(
    pg_catalog.convert_to('dasher.precommit-validator-source.v1', 'UTF8')
    || pg_catalog.decode('00', 'hex')
    || pg_catalog.decode(
      'dfdbbba8f6202cff2eeddaf82cbc4e2989f30982334351b174926dcd568fd8b2',
      'hex'
    )
    || pg_catalog.int4send(pg_catalog.octet_length('material-assertions-v1'))
    || pg_catalog.convert_to('material-assertions-v1', 'UTF8')
    || pg_catalog.int4send(pg_catalog.octet_length('bundle-evidence-uuid-v1'))
    || pg_catalog.convert_to('bundle-evidence-uuid-v1', 'UTF8')
    || pg_catalog.int4send(pg_catalog.octet_length('demo-data-mode-v1'))
    || pg_catalog.convert_to('demo-data-mode-v1', 'UTF8')
  );
  IF dasher_private.canonical_jsonb_bytes_v1(v_source_body)
      IS DISTINCT FROM v_source_result.canonical_bytes
    OR v_source_result.result_sha256 <> pg_catalog.sha256(
      pg_catalog.convert_to('dasher.recorded-result.v1', 'UTF8')
      || pg_catalog.decode('00', 'hex')
      || pg_catalog.int4send(pg_catalog.octet_length(
        v_source_result.canonical_bytes
      )) || v_source_result.canonical_bytes
    )
    OR v_nested_spec_bytes IS DISTINCT FROM p_canonical_dashboard_spec_bytes
    OR v_source_body->>'result_kind' <> v_source_result.result_kind
    OR pg_catalog.jsonb_typeof(v_source_body->'result') <> 'object'
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(
      v_source_body->'result'
    )) <> 2
    OR NOT v_source_body->'result' ?& ARRAY[
      'dashboard_spec','precommit_validation'
    ]
    OR pg_catalog.octet_length(v_precommit_bytes) NOT BETWEEN 1 AND 16384
    OR pg_catalog.jsonb_typeof(v_precommit) <> 'object'
    OR (SELECT pg_catalog.count(*)
        FROM pg_catalog.jsonb_object_keys(v_precommit)) <> 6
    OR NOT v_precommit ?& ARRAY[
      'schema','candidate_spec_sha256','validator_id',
      'validator_source_sha256','state','error_codes'
    ]
    OR v_precommit->>'schema' <> 'precommit-dashboard-validation-v1'
    OR v_precommit->>'candidate_spec_sha256' <> pg_catalog.encode(v_sha, 'hex')
    OR v_precommit->>'validator_id' <>
      '@dasher/dashboard-schema@0.1.0+task9-candidate-v1'
    OR v_precommit->>'validator_source_sha256' <>
      pg_catalog.encode(v_validator_source_sha, 'hex')
    OR v_precommit->>'state' <> 'valid'
    OR v_precommit->'error_codes' <> '[]'::jsonb
    OR v_precommit_sha <> p_precommit_validation_sha256
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  IF v_replay THEN
    -- A candidate ID is caller-supplied, so the fence receipt is the only
    -- authority binding this candidate to the exact source result.
    v_receipt_sha := pg_catalog.sha256(
      pg_catalog.convert_to('dasher.replay-candidate-receipt.v1', 'UTF8')
      || pg_catalog.decode('00', 'hex')
      || pg_catalog.uuid_send(v_run.organization_id)
      || pg_catalog.uuid_send(v_run.dashboard_id)
      || pg_catalog.uuid_send(v_run.run_id)
      || pg_catalog.uuid_send(v_source_result.replay_source_run_id)
      || pg_catalog.uuid_send(v_run.request_payload_id)
      || pg_catalog.sha256(
        pg_catalog.convert_to('dasher.agent-run-request.v1', 'UTF8')
        || pg_catalog.decode('00', 'hex')
        || pg_catalog.int4send(pg_catalog.octet_length(
          v_request_payload.canonical_bytes
        )) || v_request_payload.canonical_bytes
      )
      || pg_catalog.int4send(pg_catalog.octet_length('commit_candidate'))
      || pg_catalog.convert_to('commit_candidate', 'UTF8')
      || pg_catalog.uuid_send(NULLIF(current_setting(
        'dasher.run_principal_id', true
      ), '')::uuid)
      || pg_catalog.int8send(NULLIF(current_setting(
        'dasher.run_principal_revision', true
      ), '')::bigint)
      || pg_catalog.decode(NULLIF(current_setting(
        'dasher.run_principal_sha256', true
      ), ''), 'hex')
      || pg_catalog.uuid_send(v_run.requesting_membership_id)
      || pg_catalog.uuid_send(v_run.requesting_user_id)
      || pg_catalog.int8send(v_run.requesting_authority_revision)
      || pg_catalog.int8send(v_run.policy_revision)
      || pg_catalog.int8send(NULLIF(current_setting(
        'dasher.run_lifecycle_policy_revision', true
      ), '')::bigint)
      || pg_catalog.uuid_send(p_candidate_id)
      || pg_catalog.uuid_send(p_source_result_id)
      || pg_catalog.int8send(v_source_result.replay_source_result_sequence)
      || p_source_result_sha256
      || pg_catalog.int4send(pg_catalog.octet_length(
        v_source_result.result_kind
      ))
      || pg_catalog.convert_to(v_source_result.result_kind, 'UTF8')
      || v_sha
      || p_precommit_validation_sha256
      || pg_catalog.uuid_send(v_bundle.bundle_id)
      || v_bundle.bundle_sha256
      || pg_catalog.uuid_send(v_brief.brief_id)
      || v_brief.brief_sha256
      || pg_catalog.int4send(pg_catalog.octet_length(
        v_body->>'generatedAt'
      ))
      || pg_catalog.convert_to(v_body->>'generatedAt', 'UTF8')
    );
    IF v_receipt_sha IS NULL
      OR COALESCE(current_setting(
        'dasher.run_replay_candidate_receipt_sha256', true
      ), '') !~ '^[0-9a-f]{64}$'
    THEN
      RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
    END IF;
    IF pg_catalog.decode(current_setting(
      'dasher.run_replay_candidate_receipt_sha256', true
    ), 'hex') IS DISTINCT FROM v_receipt_sha THEN
      RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
    END IF;
    PERFORM pg_catalog.set_config(
      'dasher.run_replay_candidate_receipt_sha256', '', true
    );
  END IF;
  SELECT candidate.* INTO v_existing FROM dasher.agent_candidates AS candidate
  WHERE candidate.organization_id = v_run.organization_id
    AND candidate.dashboard_id = v_run.dashboard_id AND candidate.run_id = v_run.run_id
    AND candidate.candidate_id = p_candidate_id;
  IF FOUND THEN
    SELECT payload.* INTO STRICT v_existing_payload
    FROM dasher.agent_candidate_payloads AS payload
    WHERE payload.organization_id = v_existing.organization_id
      AND payload.dashboard_id = v_existing.dashboard_id
      AND payload.run_id = v_existing.run_id
      AND payload.candidate_id = v_existing.candidate_id;
    IF v_existing.brief_id <> v_brief.brief_id
      OR v_existing.common_bundle_id <> v_bundle.bundle_id
      OR v_existing.source_result_id <> p_source_result_id
      OR v_existing.source_result_sha256 <> p_source_result_sha256
      OR v_existing.precommit_validation_sha256 <>
        p_precommit_validation_sha256
      OR v_existing.candidate_spec_sha256 <> v_sha
      OR v_existing.material_claim_count <> v_claim_count
      OR v_existing.material_claim_set_sha256 <> v_claim_set_sha
      OR v_existing_payload.canonical_bytes <>
        p_canonical_dashboard_spec_bytes
      OR v_existing_payload.candidate_spec_sha256 <> v_sha
      OR v_existing_payload.created_at <> v_existing.created_at
      OR NOT EXISTS (
        SELECT 1
        FROM dasher.agent_run_events AS event
        WHERE event.organization_id = v_run.organization_id
          AND event.dashboard_id = v_run.dashboard_id
          AND event.run_id = v_run.run_id
          AND event.event_kind = 'candidate_committed'
          AND event.occurred_at = v_existing.created_at
      )
    THEN
      RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
    END IF;
    RETURN ROW(
      ROW(v_run.run_id, v_run.run_revision, v_run.state,
        v_run.current_event_sequence, v_run.current_event_sha256,
        v_run.lease_epoch)::dasher_run_api.run_mutation_result,
      p_candidate_id, v_sha
    )::dasher_run_api.content_commit_result;
  END IF;
  IF v_run.state NOT IN ('generating', 'revising')
    OR v_run.candidate_set_sha256 IS NOT NULL
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  IF (SELECT pg_catalog.count(*) FROM dasher.agent_candidates AS candidate
      WHERE candidate.organization_id = v_run.organization_id
        AND candidate.dashboard_id = v_run.dashboard_id
        AND candidate.run_id = v_run.run_id) >= 2
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  INSERT INTO dasher.agent_candidates (
    organization_id, dashboard_id, run_id, candidate_id, brief_id,
    common_bundle_id, source_result_id, source_result_sha256,
    precommit_validation_sha256, candidate_spec_sha256, material_claim_count,
    material_claim_set_sha256, validation_state, review_state, manifest_sha256,
    rank, selected, created_at
  ) VALUES (
    v_run.organization_id, v_run.dashboard_id, v_run.run_id, p_candidate_id,
    v_brief.brief_id, v_bundle.bundle_id, p_source_result_id,
    p_source_result_sha256, p_precommit_validation_sha256, v_sha,
    v_claim_count, v_claim_set_sha, 'pending', 'pending', NULL, NULL, false,
    pg_catalog.statement_timestamp()
  );
  INSERT INTO dasher.agent_candidate_payloads (
    organization_id, dashboard_id, run_id, candidate_id, canonical_bytes,
    candidate_spec_sha256, created_at
  ) VALUES (
    v_run.organization_id, v_run.dashboard_id, v_run.run_id, p_candidate_id,
    p_canonical_dashboard_spec_bytes, v_sha, pg_catalog.statement_timestamp()
  );
  v_mutation := dasher_private.append_agent_run_event_v1(
    v_run.run_id, dasher_private.uuid_v8_from_sha256_v1(pg_catalog.convert_to(pg_catalog.clock_timestamp()::text || '|' || pg_catalog.txid_current()::text || '|' || pg_catalog.random()::text, 'UTF8')), 'candidate_committed',
    pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'candidate_id', p_candidate_id::text,
      'candidate_spec_sha256', pg_catalog.encode(v_sha, 'hex'),
      'source_result_id', p_source_result_id::text,
      'source_result_sha256', pg_catalog.encode(p_source_result_sha256, 'hex'),
      'precommit_validation_sha256', pg_catalog.encode(
        p_precommit_validation_sha256, 'hex'
      ),
      'bundle_sha256', pg_catalog.encode(p_common_bundle_sha256, 'hex'),
      'material_claim_count', 'i64:' || v_claim_count::text,
      'material_claim_set_sha256', pg_catalog.encode(v_claim_set_sha, 'hex')
    )::text, 'UTF8')
  );
  RETURN ROW(v_mutation, p_candidate_id, v_sha)
    ::dasher_run_api.content_commit_result;
END
$function$;

CREATE OR REPLACE FUNCTION dasher_run_api.commit_agent_validation_findings(
  p_run_id uuid,
  p_lease_epoch bigint,
  p_attempt_token bytea,
  p_candidate_id uuid,
  p_canonical_findings_bytes bytea
)
RETURNS dasher_run_api.validation_findings_result
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_run dasher.agent_runs%ROWTYPE;
  v_candidate dasher.agent_candidates%ROWTYPE;
  v_discovered_candidate dasher.agent_candidates%ROWTYPE;
  v_bundle dasher.candidate_comparison_bundles%ROWTYPE;
  v_body jsonb;
  v_count integer;
  v_state text;
  v_event_state text;
  v_sha bytea;
  v_existing dasher.agent_validation_findings%ROWTYPE;
  v_mutation dasher_run_api.run_mutation_result;
BEGIN
  IF p_candidate_id IS NULL OR p_canonical_findings_bytes IS NULL
    OR pg_catalog.octet_length(p_canonical_findings_bytes) NOT BETWEEN 1 AND 65536
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  BEGIN
    v_body := pg_catalog.convert_from(p_canonical_findings_bytes, 'UTF8')::jsonb;
  EXCEPTION WHEN character_not_in_repertoire OR invalid_text_representation THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END;
  IF dasher_private.canonical_jsonb_bytes_v1(v_body)
      IS DISTINCT FROM p_canonical_findings_bytes
    OR pg_catalog.jsonb_typeof(v_body) <> 'object'
    OR (SELECT pg_catalog.count(*)
        FROM pg_catalog.jsonb_object_keys(v_body)) <> 4
    OR NOT v_body ?& ARRAY[
      'schema','candidate_id','candidate_spec_sha256','findings'
    ]
    OR v_body->>'schema' <> 'agent-validation-findings-v1'
    OR v_body->>'candidate_id' !~
      '^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR (v_body->>'candidate_id')::uuid <> p_candidate_id
    OR pg_catalog.jsonb_typeof(v_body->'findings') <> 'array'
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  v_count := pg_catalog.jsonb_array_length(v_body->'findings');
  IF v_count > 64 THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(v_body->'findings')
      WITH ORDINALITY AS finding(value, ordinal)
    WHERE pg_catalog.jsonb_typeof(finding.value) <> 'object'
      OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(
        finding.value
      )) <> 6
      OR NOT finding.value ?& ARRAY[
        'kind','severity','subject_kind','subject_id','json_pointer',
        'related_sha256'
      ]
      OR finding.value->>'kind' NOT IN (
        'schema_violation','unsupported_component','unknown_field',
        'metric_contract_mismatch','calculation_error',
        'evidence_incomplete','policy_violation'
      )
      OR finding.value->>'severity' NOT IN ('error','warning')
      OR finding.value->>'subject_kind' NOT IN (
        'candidate','calculation','evidence'
      )
      OR pg_catalog.octet_length(finding.value->>'json_pointer') > 256
      OR finding.value->>'json_pointer' !~
        '^(?:|(?:/(?:[^~/[:cntrl:]]|~0|~1)*)+)$'
      OR (finding.value->>'subject_kind' = 'candidate' AND NOT (
        finding.value->'subject_id' = 'null'::jsonb
        AND finding.value->'related_sha256' = 'null'::jsonb
      ))
      OR (finding.value->>'subject_kind' <> 'candidate' AND (
        finding.value->>'subject_id' !~
          '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        OR finding.value->>'related_sha256' !~ '^[0-9a-f]{64}$'
      ))
      OR EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_array_elements(v_body->'findings')
          WITH ORDINALITY AS prior(value, ordinal)
        WHERE prior.ordinal = finding.ordinal - 1
          AND ROW(
            pg_catalog.array_position(
              ARRAY['error','warning'], prior.value->>'severity'
            ),
            pg_catalog.array_position(ARRAY[
              'schema_violation','unsupported_component','unknown_field',
              'metric_contract_mismatch','calculation_error',
              'evidence_incomplete','policy_violation'
            ], prior.value->>'kind'),
            pg_catalog.array_position(
              ARRAY['candidate','calculation','evidence'],
              prior.value->>'subject_kind'
            ), COALESCE(prior.value->>'subject_id',''),
            prior.value->>'json_pointer',
            COALESCE(prior.value->>'related_sha256','')
          ) >= ROW(
            pg_catalog.array_position(
              ARRAY['error','warning'], finding.value->>'severity'
            ),
            pg_catalog.array_position(ARRAY[
              'schema_violation','unsupported_component','unknown_field',
              'metric_contract_mismatch','calculation_error',
              'evidence_incomplete','policy_violation'
            ], finding.value->>'kind'),
            pg_catalog.array_position(
              ARRAY['candidate','calculation','evidence'],
              finding.value->>'subject_kind'
            ), COALESCE(finding.value->>'subject_id',''),
            finding.value->>'json_pointer',
            COALESCE(finding.value->>'related_sha256','')
          )
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  v_state := CASE WHEN EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_array_elements(v_body->'findings') AS finding(value)
    WHERE finding.value->>'severity' = 'error'
  ) THEN 'invalid' ELSE 'valid' END;
  v_event_state := CASE WHEN v_state = 'invalid' THEN 'failed'
    WHEN v_count = 0 THEN 'passed' ELSE 'passed_with_warnings' END;
  v_sha := pg_catalog.sha256(
    pg_catalog.convert_to('dasher.agent-validation-findings.v1', 'UTF8')
    || pg_catalog.decode('00', 'hex')
    || pg_catalog.int4send(pg_catalog.octet_length(p_canonical_findings_bytes))
    || p_canonical_findings_bytes
  );
  PERFORM dasher_private.initialize_run_operator_context_v1(p_run_id, 'commit_validation');
  PERFORM dasher_private.reauthorize_agent_run_v1(p_run_id, p_lease_epoch, p_attempt_token);
  IF NULLIF(current_setting(
    'dasher.run_replay_source_id', true
  ), '') IS NOT NULL THEN
    PERFORM dasher_private.replay_source_fence_v1(
      NULLIF(current_setting('dasher.run_organization_id', true), '')::uuid,
      NULLIF(current_setting('dasher.run_replay_source_id', true), '')::uuid
    );
    PERFORM pg_catalog.set_config('dasher.run_phase', 'authorized', true);
  END IF;
  SELECT run.* INTO STRICT v_run FROM dasher.agent_runs AS run
  WHERE run.organization_id = current_setting('dasher.run_organization_id', true)::uuid
    AND run.run_id = p_run_id FOR UPDATE;
  IF v_run.state <> 'validating' THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  SELECT candidate.* INTO STRICT v_discovered_candidate
  FROM dasher.agent_candidates AS candidate
  WHERE candidate.organization_id = v_run.organization_id
    AND candidate.dashboard_id = v_run.dashboard_id
    AND candidate.run_id = v_run.run_id
    AND candidate.candidate_id = p_candidate_id
    AND candidate.candidate_spec_sha256 = pg_catalog.decode(
      v_body->>'candidate_spec_sha256', 'hex'
    )
  ;
  SELECT bundle.* INTO STRICT v_bundle
  FROM dasher.candidate_comparison_bundles AS bundle
  WHERE bundle.organization_id = v_discovered_candidate.organization_id
    AND bundle.dashboard_id = v_discovered_candidate.dashboard_id
    AND bundle.run_id = v_discovered_candidate.run_id
    AND bundle.bundle_id = v_discovered_candidate.common_bundle_id
  FOR UPDATE;
  SELECT candidate.* INTO STRICT v_candidate
  FROM dasher.agent_candidates AS candidate
  WHERE candidate.organization_id = v_discovered_candidate.organization_id
    AND candidate.dashboard_id = v_discovered_candidate.dashboard_id
    AND candidate.run_id = v_discovered_candidate.run_id
    AND candidate.candidate_id = v_discovered_candidate.candidate_id
  FOR UPDATE;
  IF v_candidate IS DISTINCT FROM v_discovered_candidate THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(v_body->'findings') AS finding(value)
    WHERE (finding.value->>'subject_kind' = 'calculation' AND NOT EXISTS (
      SELECT 1 FROM dasher.calculation_results AS result
      WHERE result.organization_id = v_run.organization_id
        AND result.dashboard_id = v_run.dashboard_id
        AND result.run_id = v_run.run_id
        AND result.result_id = (finding.value->>'subject_id')::uuid
        AND result.result_sha256 = pg_catalog.decode(
          finding.value->>'related_sha256', 'hex'
        )
    )) OR (finding.value->>'subject_kind' = 'evidence' AND NOT EXISTS (
      SELECT 1 FROM dasher.candidate_comparison_bundle_evidence AS evidence
      WHERE evidence.organization_id = v_run.organization_id
        AND evidence.dashboard_id = v_run.dashboard_id
        AND evidence.run_id = v_run.run_id
        AND evidence.bundle_id = v_candidate.common_bundle_id
        AND evidence.evidence_id = (finding.value->>'subject_id')::uuid
        AND evidence.evidence_sha256 = pg_catalog.decode(
          finding.value->>'related_sha256', 'hex'
        )
    ))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  SELECT finding.* INTO v_existing FROM dasher.agent_validation_findings AS finding
  WHERE finding.organization_id = v_run.organization_id
    AND finding.dashboard_id = v_run.dashboard_id AND finding.run_id = v_run.run_id
    AND finding.candidate_id = p_candidate_id;
  IF FOUND THEN
    IF v_existing.findings_sha256 <> v_sha
      OR v_existing.canonical_bytes <> p_canonical_findings_bytes
      OR v_existing.finding_count <> v_count
      OR v_existing.validation_state <> v_state
    THEN
      RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
    END IF;
    RETURN ROW(
      ROW(v_run.run_id, v_run.run_revision, v_run.state,
        v_run.current_event_sequence, v_run.current_event_sha256,
        v_run.lease_epoch)::dasher_run_api.run_mutation_result,
      p_candidate_id, v_count, v_sha, v_state
    )::dasher_run_api.validation_findings_result;
  END IF;
  INSERT INTO dasher.agent_validation_findings (
    organization_id, dashboard_id, run_id, candidate_id, finding_count,
    validation_state, findings_sha256, canonical_bytes, created_at
  ) VALUES (
    v_run.organization_id, v_run.dashboard_id, v_run.run_id, p_candidate_id,
    v_count, v_state, v_sha, p_canonical_findings_bytes,
    pg_catalog.statement_timestamp()
  );
  UPDATE dasher.agent_candidates AS candidate
  SET validation_state = v_state
  WHERE candidate.organization_id = v_run.organization_id
    AND candidate.dashboard_id = v_run.dashboard_id AND candidate.run_id = v_run.run_id
    AND candidate.candidate_id = p_candidate_id;
  v_mutation := dasher_private.append_agent_run_event_v1(
    v_run.run_id, dasher_private.uuid_v8_from_sha256_v1(pg_catalog.convert_to(pg_catalog.clock_timestamp()::text || '|' || pg_catalog.txid_current()::text || '|' || pg_catalog.random()::text, 'UTF8')),
    'candidate_validation_findings_committed',
    pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'candidate_id', p_candidate_id::text,
      'finding_count', 'i64:' || v_count::text,
      'findings_sha256', pg_catalog.encode(v_sha, 'hex'),
      'validation_state', v_event_state
    )::text, 'UTF8')
  );
  RETURN ROW(v_mutation, p_candidate_id, v_count, v_sha, v_state)
    ::dasher_run_api.validation_findings_result;
END
$function$;

CREATE OR REPLACE FUNCTION dasher_run_api.close_agent_candidate_set(
  p_run_id uuid,
  p_lease_epoch bigint,
  p_attempt_token bytea,
  p_ordered_candidate_set_sha256 bytea
)
RETURNS dasher_run_api.candidate_set_result
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_run dasher.agent_runs%ROWTYPE;
  v_bundle dasher.candidate_comparison_bundles%ROWTYPE;
  v_brief dasher.briefs%ROWTYPE;
  v_ids uuid[];
  v_count integer;
  v_sha bytea;
  v_preimage bytea;
  v_candidate record;
  v_mutation dasher_run_api.run_mutation_result;
BEGIN
  IF pg_catalog.octet_length(p_ordered_candidate_set_sha256) <> 32 THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  PERFORM dasher_private.initialize_run_operator_context_v1(p_run_id, 'close_candidate_set');
  PERFORM dasher_private.reauthorize_agent_run_v1(p_run_id, p_lease_epoch, p_attempt_token);
  IF NULLIF(current_setting(
    'dasher.run_replay_source_id', true
  ), '') IS NOT NULL THEN
    PERFORM dasher_private.replay_source_fence_v1(
      NULLIF(current_setting('dasher.run_organization_id', true), '')::uuid,
      NULLIF(current_setting('dasher.run_replay_source_id', true), '')::uuid
    );
    PERFORM pg_catalog.set_config('dasher.run_phase', 'authorized', true);
  END IF;
  SELECT run.* INTO STRICT v_run FROM dasher.agent_runs AS run
  WHERE run.organization_id = current_setting('dasher.run_organization_id', true)::uuid
    AND run.run_id = p_run_id FOR UPDATE;
  SELECT bundle.* INTO STRICT v_bundle
  FROM dasher.candidate_comparison_bundles AS bundle
  WHERE bundle.organization_id = v_run.organization_id
    AND bundle.dashboard_id = v_run.dashboard_id
    AND bundle.run_id = v_run.run_id
  FOR UPDATE;
  SELECT brief.* INTO STRICT v_brief
  FROM dasher.briefs AS brief
  WHERE brief.organization_id = v_run.organization_id
    AND brief.dashboard_id = v_run.dashboard_id
    AND brief.run_id = v_run.run_id
    AND brief.common_bundle_id = v_bundle.bundle_id;
  SELECT pg_catalog.array_agg(candidate.candidate_id
        ORDER BY pg_catalog.uuid_send(candidate.candidate_id)),
      pg_catalog.count(*)::integer
    INTO v_ids, v_count
  FROM dasher.agent_candidates AS candidate
  WHERE candidate.organization_id = v_run.organization_id
    AND candidate.dashboard_id = v_run.dashboard_id AND candidate.run_id = v_run.run_id
    AND candidate.validation_state = 'pending';
  IF v_count NOT BETWEEN 1 AND 2 THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  v_preimage := pg_catalog.convert_to('dasher.candidate-set.v1', 'UTF8')
    || pg_catalog.decode('00', 'hex')
    || v_bundle.bundle_sha256
    || v_brief.brief_sha256
    || pg_catalog.int8send(v_count);
  FOR v_candidate IN
    SELECT candidate.candidate_id, candidate.candidate_spec_sha256
    FROM dasher.agent_candidates AS candidate
    WHERE candidate.organization_id = v_run.organization_id
      AND candidate.dashboard_id = v_run.dashboard_id
      AND candidate.run_id = v_run.run_id
      AND candidate.validation_state = 'pending'
    ORDER BY pg_catalog.uuid_send(candidate.candidate_id)
  LOOP
    v_preimage := v_preimage
      || pg_catalog.uuid_send(v_candidate.candidate_id)
      || v_candidate.candidate_spec_sha256;
  END LOOP;
  v_sha := pg_catalog.sha256(v_preimage);
  IF v_sha <> p_ordered_candidate_set_sha256 THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  IF v_run.candidate_set_sha256 IS NOT NULL THEN
    IF v_run.candidate_set_sha256 <> v_sha THEN
      RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
    END IF;
    RETURN ROW(
      ROW(v_run.run_id, v_run.run_revision, v_run.state,
        v_run.current_event_sequence, v_run.current_event_sha256,
        v_run.lease_epoch)::dasher_run_api.run_mutation_result,
      v_ids, v_count, v_sha
    )::dasher_run_api.candidate_set_result;
  END IF;
  PERFORM pg_catalog.set_config(
    'dasher.run_next_state', 'validating', true
  );
  PERFORM pg_catalog.set_config(
    'dasher.run_candidate_set_sha256', pg_catalog.encode(v_sha, 'hex'), true
  );
  v_mutation := dasher_private.append_agent_run_event_v1(
    v_run.run_id, dasher_private.uuid_v8_from_sha256_v1(pg_catalog.convert_to(pg_catalog.clock_timestamp()::text || '|' || pg_catalog.txid_current()::text || '|' || pg_catalog.random()::text, 'UTF8')), 'candidate_set_closed',
    pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'candidate_ids', pg_catalog.to_jsonb(v_ids),
      'candidate_set_sha256', pg_catalog.encode(v_sha, 'hex')
    )::text, 'UTF8')
  );
  RETURN ROW(v_mutation, v_ids, v_count, v_sha)
    ::dasher_run_api.candidate_set_result;
END
$function$;

CREATE OR REPLACE FUNCTION dasher_run_api.commit_candidate_claims(
  p_run_id uuid,
  p_lease_epoch bigint,
  p_attempt_token bytea,
  p_candidate_id uuid,
  p_canonical_claim_edge_set_bytes bytea
)
RETURNS dasher_run_api.claim_set_result
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_run dasher.agent_runs%ROWTYPE;
  v_candidate dasher.agent_candidates%ROWTYPE;
  v_discovered_candidate dasher.agent_candidates%ROWTYPE;
  v_bundle dasher.candidate_comparison_bundles%ROWTYPE;
  v_candidate_payload dasher.agent_candidate_payloads%ROWTYPE;
  v_body jsonb;
  v_spec jsonb;
  v_assertions jsonb;
  v_assertion jsonb;
  v_sha bytea;
  v_claim_count integer;
  v_edge_count integer;
  v_claim record;
  v_result dasher.calculation_results%ROWTYPE;
  v_graph dasher.calculation_graphs%ROWTYPE;
  v_contract dasher.metric_contract_versions%ROWTYPE;
  v_request dasher.agent_run_request_payloads%ROWTYPE;
  v_catalog dasher.field_catalog_snapshots%ROWTYPE;
  v_source dasher.source_snapshots%ROWTYPE;
  v_claim_bytes bytea;
  v_lineage_ids uuid[];
  v_subtree jsonb;
  v_output jsonb;
  v_selected_value jsonb;
  v_display text;
  v_display_unit text;
  v_display_currency text;
  v_graph_body jsonb;
  v_request_body jsonb;
  v_latest_observation_at text;
  v_latest_observation_row_id uuid;
  v_expected_freshness text;
  v_event_time_field_id uuid;
  v_existing_claims jsonb;
  v_existing_edges jsonb;
  v_mutation dasher_run_api.run_mutation_result;
BEGIN
  IF p_candidate_id IS NULL OR p_canonical_claim_edge_set_bytes IS NULL
    OR pg_catalog.octet_length(p_canonical_claim_edge_set_bytes) NOT BETWEEN 1 AND 262144
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  BEGIN
    v_body := pg_catalog.convert_from(p_canonical_claim_edge_set_bytes, 'UTF8')::jsonb;
  EXCEPTION WHEN character_not_in_repertoire OR invalid_text_representation THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END;
  IF dasher_private.canonical_jsonb_bytes_v1(v_body)
      IS DISTINCT FROM p_canonical_claim_edge_set_bytes
    OR pg_catalog.jsonb_typeof(v_body) <> 'object'
    OR (SELECT pg_catalog.count(*)
        FROM pg_catalog.jsonb_object_keys(v_body)) <> 6
    OR NOT v_body ?& ARRAY[
      'schema','candidate_id','candidate_spec_sha256',
      'material_claim_set_sha256','claims','edges'
    ]
    OR v_body->>'schema' <> 'candidate-claims-v1'
    OR v_body->>'candidate_id' !~
      '^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR (v_body->>'candidate_id')::uuid <> p_candidate_id
    OR pg_catalog.jsonb_typeof(v_body->'claims') <> 'array'
    OR pg_catalog.jsonb_typeof(v_body->'edges') <> 'array'
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  v_claim_count := pg_catalog.jsonb_array_length(v_body->'claims');
  v_edge_count := pg_catalog.jsonb_array_length(v_body->'edges');
  IF v_claim_count NOT BETWEEN 1 AND 64 OR v_edge_count NOT BETWEEN 0 AND 256 THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  IF EXISTS (
      SELECT 1
      FROM pg_catalog.jsonb_array_elements(v_body->'claims')
        WITH ORDINALITY AS claim(value, ordinal)
      WHERE pg_catalog.jsonb_typeof(claim.value) <> 'object'
        OR (SELECT pg_catalog.count(*)
            FROM pg_catalog.jsonb_object_keys(claim.value)) <> 14
        OR NOT claim.value ?& ARRAY[
          'claim_id','json_pointer','assertion_sha256','label','statement',
          'salience','evidence_state','calculation_result_id',
          'calculation_output_identity_kind','calculation_output_node_id',
          'calculation_output_sha256','calculation_output_row_id',
          'calculation_output_field_id','calculation_output_value_sha256'
        ]
        OR claim.value->>'claim_id' !~
          '^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        OR pg_catalog.octet_length(claim.value->>'json_pointer')
          NOT BETWEEN 1 AND 512
        OR claim.value->>'json_pointer' !~
          '^(?:/(?:[^~/[:cntrl:]]|~0|~1)*)+$'
        OR claim.value->>'assertion_sha256' !~ '^[0-9a-f]{64}$'
        OR claim.value->>'label' NOT IN (
          'observed','calculated','hypothesis','recommendation',
          'unknown','blocked'
        )
        OR claim.value->>'salience' NOT IN ('high','normal')
        OR claim.value->>'evidence_state' NOT IN (
          'complete','partial','contradicted','stale','unsupported'
        )
        OR (claim.value->>'statement') <>
          (claim.value->>'json_pointer') || ' sha256:'
          || (claim.value->>'assertion_sha256')
        OR (claim.value->>'label' <> 'calculated' AND NOT (
          claim.value->'calculation_result_id' = 'null'::jsonb
          AND claim.value->'calculation_output_identity_kind' = 'null'::jsonb
          AND claim.value->'calculation_output_node_id' = 'null'::jsonb
          AND claim.value->'calculation_output_sha256' = 'null'::jsonb
          AND claim.value->'calculation_output_row_id' = 'null'::jsonb
          AND claim.value->'calculation_output_field_id' = 'null'::jsonb
          AND claim.value->'calculation_output_value_sha256' = 'null'::jsonb
        ))
        OR (claim.value->>'label' = 'calculated' AND (
          claim.value->>'calculation_result_id' !~
            '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          OR claim.value->>'calculation_output_identity_kind' NOT IN (
            'output','scalar_row','rowset_cell'
          )
          OR claim.value->>'calculation_output_node_id' !~
            '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          OR claim.value->>'calculation_output_sha256' !~ '^[0-9a-f]{64}$'
          OR (claim.value->>'calculation_output_identity_kind' = 'output'
            AND NOT (claim.value->'calculation_output_row_id' = 'null'::jsonb
              AND claim.value->'calculation_output_field_id' = 'null'::jsonb
              AND claim.value->'calculation_output_value_sha256' = 'null'::jsonb))
          OR (claim.value->>'calculation_output_identity_kind' = 'scalar_row'
            AND NOT (claim.value->>'calculation_output_row_id' ~
                '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
              AND claim.value->'calculation_output_field_id' = 'null'::jsonb
              AND claim.value->>'calculation_output_value_sha256' ~
                '^[0-9a-f]{64}$'))
          OR (claim.value->>'calculation_output_identity_kind' = 'rowset_cell'
            AND NOT (claim.value->>'calculation_output_row_id' ~
                '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
              AND claim.value->>'calculation_output_field_id' ~
                '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
              AND claim.value->>'calculation_output_value_sha256' ~
                '^[0-9a-f]{64}$'))
        ))
        OR EXISTS (
          SELECT 1
          FROM pg_catalog.jsonb_array_elements(v_body->'claims')
            WITH ORDINALITY AS prior(value, ordinal)
          WHERE prior.ordinal = claim.ordinal - 1
            AND pg_catalog.uuid_send((prior.value->>'claim_id')::uuid) >=
              pg_catalog.uuid_send((claim.value->>'claim_id')::uuid)
        )
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.jsonb_array_elements(v_body->'edges')
        WITH ORDINALITY AS edge(value, ordinal)
      WHERE pg_catalog.jsonb_typeof(edge.value) <> 'object'
        OR (SELECT pg_catalog.count(*)
            FROM pg_catalog.jsonb_object_keys(edge.value)) <> 3
        OR NOT edge.value ?& ARRAY['claim_id','evidence_id','relation']
        OR edge.value->>'claim_id' !~
          '^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        OR edge.value->>'evidence_id' !~
          '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        OR edge.value->>'relation' NOT IN ('supports','contradicts','context')
        OR EXISTS (
          SELECT 1
          FROM pg_catalog.jsonb_array_elements(v_body->'edges')
            WITH ORDINALITY AS prior(value, ordinal)
          WHERE prior.ordinal = edge.ordinal - 1
            AND ROW(
              pg_catalog.uuid_send((prior.value->>'claim_id')::uuid),
              pg_catalog.uuid_send((prior.value->>'evidence_id')::uuid),
              pg_catalog.array_position(
                ARRAY['supports','contradicts','context'],
                prior.value->>'relation'
              )
            ) >= ROW(
              pg_catalog.uuid_send((edge.value->>'claim_id')::uuid),
              pg_catalog.uuid_send((edge.value->>'evidence_id')::uuid),
              pg_catalog.array_position(
                ARRAY['supports','contradicts','context'],
                edge.value->>'relation'
              )
            )
        )
    )
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  v_sha := pg_catalog.sha256(
    pg_catalog.convert_to('dasher.candidate-claims.v1', 'UTF8')
    || pg_catalog.decode('00', 'hex')
    || pg_catalog.int4send(pg_catalog.octet_length(p_canonical_claim_edge_set_bytes))
    || p_canonical_claim_edge_set_bytes
  );
  PERFORM dasher_private.initialize_run_operator_context_v1(p_run_id, 'commit_claims');
  PERFORM dasher_private.reauthorize_agent_run_v1(p_run_id, p_lease_epoch, p_attempt_token);
  IF NULLIF(current_setting(
    'dasher.run_replay_source_id', true
  ), '') IS NOT NULL THEN
    PERFORM dasher_private.replay_source_fence_v1(
      NULLIF(current_setting('dasher.run_organization_id', true), '')::uuid,
      NULLIF(current_setting('dasher.run_replay_source_id', true), '')::uuid
    );
    PERFORM pg_catalog.set_config('dasher.run_phase', 'authorized', true);
  END IF;
  SELECT run.* INTO STRICT v_run FROM dasher.agent_runs AS run
  WHERE run.organization_id = current_setting('dasher.run_organization_id', true)::uuid
    AND run.run_id = p_run_id FOR UPDATE;
  SELECT candidate.* INTO STRICT v_discovered_candidate
  FROM dasher.agent_candidates AS candidate
  WHERE candidate.organization_id = v_run.organization_id
    AND candidate.dashboard_id = v_run.dashboard_id AND candidate.run_id = v_run.run_id
    AND candidate.candidate_id = p_candidate_id;
  SELECT bundle.* INTO STRICT v_bundle
  FROM dasher.candidate_comparison_bundles AS bundle
  WHERE bundle.organization_id = v_discovered_candidate.organization_id
    AND bundle.dashboard_id = v_discovered_candidate.dashboard_id
    AND bundle.run_id = v_discovered_candidate.run_id
    AND bundle.bundle_id = v_discovered_candidate.common_bundle_id
  FOR UPDATE;
  SELECT candidate.* INTO STRICT v_candidate
  FROM dasher.agent_candidates AS candidate
  WHERE candidate.organization_id = v_discovered_candidate.organization_id
    AND candidate.dashboard_id = v_discovered_candidate.dashboard_id
    AND candidate.run_id = v_discovered_candidate.run_id
    AND candidate.candidate_id = v_discovered_candidate.candidate_id
  FOR UPDATE;
  IF v_candidate IS DISTINCT FROM v_discovered_candidate THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  SELECT payload.* INTO STRICT v_candidate_payload
  FROM dasher.agent_candidate_payloads AS payload
  WHERE payload.organization_id = v_candidate.organization_id
    AND payload.dashboard_id = v_candidate.dashboard_id
    AND payload.run_id = v_candidate.run_id
    AND payload.candidate_id = v_candidate.candidate_id;
  v_spec := pg_catalog.convert_from(
    v_candidate_payload.canonical_bytes, 'UTF8'
  )::jsonb;
  v_assertions := dasher_private.extract_material_assertions_v1(
    v_candidate_payload.canonical_bytes, v_candidate.candidate_spec_sha256
  );
  IF v_candidate.validation_state <> 'valid'
    OR v_candidate.material_claim_count <> v_claim_count
    OR v_candidate_payload.candidate_spec_sha256 <>
      v_candidate.candidate_spec_sha256
    OR dasher_private.validate_dashboard_spec_v1(
      v_candidate_payload.canonical_bytes
    ) IS DISTINCT FROM true
    OR pg_catalog.jsonb_array_length(v_assertions) <> v_claim_count
    OR dasher_private.material_claim_set_sha256_v1(
      v_candidate.candidate_spec_sha256, v_assertions
    ) <> v_candidate.material_claim_set_sha256
    OR v_body->>'candidate_spec_sha256' <> pg_catalog.encode(v_candidate.candidate_spec_sha256, 'hex')
    OR v_body->>'material_claim_set_sha256' <> pg_catalog.encode(v_candidate.material_claim_set_sha256, 'hex')
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  FOR v_claim IN
    SELECT item.value, item.ordinal
    FROM pg_catalog.jsonb_array_elements(v_body->'claims') WITH ORDINALITY
      AS item(value, ordinal)
    ORDER BY item.ordinal
  LOOP
    SELECT assertion.value INTO v_assertion
    FROM pg_catalog.jsonb_array_elements(v_assertions) AS assertion(value)
    WHERE assertion.value->>'claim_id' = v_claim.value->>'claim_id';
    IF NOT FOUND
      OR v_assertion->>'json_pointer' <> v_claim.value->>'json_pointer'
      OR v_assertion->>'assertion_sha256' <>
        v_claim.value->>'assertion_sha256'
      OR NOT v_assertion->'allowed_labels' ? (v_claim.value->>'label')
      OR (v_claim.value->>'label' IN (
          'hypothesis','recommendation','unknown','blocked'
        ) AND v_claim.value->>'evidence_state' = 'complete')
      OR (v_claim.value->>'evidence_state' = 'complete' AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_array_elements(v_body->'edges') AS edge(value)
        JOIN dasher.candidate_comparison_bundle_evidence AS member
          ON member.organization_id = v_run.organization_id
         AND member.dashboard_id = v_run.dashboard_id
         AND member.run_id = v_run.run_id
         AND member.bundle_id = v_candidate.common_bundle_id
         AND member.evidence_id = (edge.value->>'evidence_id')::uuid
         AND member.freshness = 'current'
        WHERE edge.value->>'claim_id' = v_claim.value->>'claim_id'
          AND edge.value->>'relation' = 'supports'
      ))
      OR (v_claim.value->>'evidence_state' = 'contradicted'
        AND NOT EXISTS (
          SELECT 1
          FROM pg_catalog.jsonb_array_elements(v_body->'edges') AS edge(value)
          WHERE edge.value->>'claim_id' = v_claim.value->>'claim_id'
            AND edge.value->>'relation' = 'contradicts'
        ))
    THEN
      RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
    END IF;
    IF v_claim.value->>'label' = 'calculated' THEN
      SELECT result.* INTO STRICT v_result
      FROM dasher.calculation_results AS result
      WHERE result.organization_id = v_run.organization_id
        AND result.dashboard_id = v_run.dashboard_id
        AND result.run_id = v_run.run_id
        AND result.result_id =
          (v_claim.value->>'calculation_result_id')::uuid;
      SELECT graph.* INTO STRICT v_graph
      FROM dasher.calculation_graphs AS graph
      WHERE graph.organization_id = v_run.organization_id
        AND graph.dashboard_id = v_run.dashboard_id
        AND graph.run_id = v_run.run_id
        AND graph.graph_id = v_result.graph_id;
      SELECT contract.* INTO STRICT v_contract
      FROM dasher.metric_contract_versions AS contract
      WHERE contract.organization_id = v_run.organization_id
        AND contract.dashboard_id = v_run.dashboard_id
        AND contract.contract_set_id = v_graph.contract_set_id
        AND contract.contract_id = v_graph.contract_id
        AND contract.contract_version = v_graph.contract_version;
      v_lineage_ids := v_contract.lineage_evidence_ids;
      v_claim_bytes := dasher_private.canonical_jsonb_bytes_v1(v_claim.value);
      SELECT output.value INTO STRICT v_output
      FROM pg_catalog.jsonb_array_elements(
        pg_catalog.convert_from(v_result.canonical_bytes, 'UTF8')::jsonb
          ->'outputs'
      ) AS output(value)
      WHERE output.value->>'node_id' =
        v_claim.value->>'calculation_output_node_id';
      IF v_claim.value->>'calculation_output_identity_kind' = 'scalar_row' THEN
        SELECT result_row.value->'value' INTO STRICT v_selected_value
        FROM pg_catalog.jsonb_array_elements(v_output->'rows')
          AS result_row(value)
        WHERE result_row.value->>'row_id' =
          v_claim.value->>'calculation_output_row_id';
      ELSIF v_claim.value->>'calculation_output_identity_kind' = 'rowset_cell'
      THEN
        SELECT cell.value->'value' INTO STRICT v_selected_value
        FROM pg_catalog.jsonb_array_elements(v_output->'rows')
          AS result_row(value)
        CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(
          result_row.value->'cells'
        ) AS cell(value)
        WHERE result_row.value->>'row_id' =
            v_claim.value->>'calculation_output_row_id'
          AND cell.value->>'field_id' =
            v_claim.value->>'calculation_output_field_id';
      ELSE v_selected_value := NULL;
      END IF;
      IF v_selected_value IS NOT NULL THEN
        IF v_claim.value->>'calculation_output_identity_kind' = 'rowset_cell'
        THEN
          SELECT field.value->>'unit', field.value->>'currency'
            INTO v_display_unit, v_display_currency
          FROM pg_catalog.jsonb_array_elements(
            v_output#>'{output_type,fields}'
          ) AS field(value)
          WHERE field.value->>'field_id' =
            v_claim.value->>'calculation_output_field_id';
          IF NOT FOUND THEN
            RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
          END IF;
        ELSE
          v_display_unit := v_output#>>'{output_type,unit}';
          v_display_currency := v_output#>>'{output_type,currency}';
        END IF;
        v_display := CASE v_selected_value->>'type'
          WHEN 'boolean' THEN v_selected_value->>'value'
          WHEN 'integer' THEN pg_catalog.substr(
            v_selected_value->>'value', 5
          )
          WHEN 'decimal' THEN (
            SELECT CASE WHEN decimal_value.scale = 0
              THEN decimal_value.coefficient
              ELSE CASE WHEN decimal_value.negative THEN '-' ELSE '' END
                || CASE WHEN pg_catalog.length(decimal_value.digits) >
                    decimal_value.scale
                  THEN pg_catalog.left(
                    decimal_value.digits,
                    pg_catalog.length(decimal_value.digits)
                      - decimal_value.scale
                  ) || '.' || pg_catalog.right(
                    decimal_value.digits, decimal_value.scale
                  )
                  ELSE '0.' || pg_catalog.repeat(
                    '0', decimal_value.scale
                      - pg_catalog.length(decimal_value.digits)
                  ) || decimal_value.digits END END
            FROM (
              SELECT v_selected_value#>>'{value,coefficient}' AS coefficient,
                pg_catalog.replace(
                  v_selected_value#>>'{value,coefficient}', '-', ''
                ) AS digits,
                pg_catalog.left(
                  v_selected_value#>>'{value,coefficient}', 1
                ) = '-' AS negative,
                pg_catalog.substr(
                  v_selected_value#>>'{value,scale}', 5
                )::integer AS scale
            ) AS decimal_value
          )
          WHEN 'duration' THEN pg_catalog.substr(
            v_selected_value->>'value', 5
          ) || ' us'
          ELSE v_selected_value->>'value' END;
        IF v_display_currency IS NOT NULL THEN
          v_display := v_display || ' ' || v_display_currency;
        ELSIF v_display_unit IS NOT NULL THEN
          v_display := v_display || ' ' || v_display_unit;
        END IF;
      END IF;
      v_subtree := v_spec #> pg_catalog.string_to_array(
        pg_catalog.substr(v_claim.value->>'json_pointer', 2), '/'
      );
      IF v_claim.value->>'json_pointer' = '/freshness' THEN
        SELECT payload.* INTO STRICT v_request
        FROM dasher.agent_run_request_payloads AS payload
        WHERE payload.organization_id = v_run.organization_id
          AND payload.dashboard_id = v_run.dashboard_id
          AND payload.request_payload_id = v_run.request_payload_id;
        v_request_body := pg_catalog.convert_from(
          v_request.canonical_bytes, 'UTF8'
        )::jsonb;
        v_graph_body := pg_catalog.convert_from(
          v_graph.canonical_bytes, 'UTF8'
        )::jsonb;
        SELECT source.* INTO STRICT v_source
        FROM dasher.source_snapshots AS source
        WHERE source.organization_id = v_run.organization_id
          AND source.snapshot_id = (v_request_body->>'input_snapshot_id')::uuid
        FOR KEY SHARE;
        SELECT catalog.* INTO STRICT v_catalog
        FROM dasher.field_catalog_snapshots AS catalog
        WHERE catalog.organization_id = v_run.organization_id
          AND catalog.dashboard_id = v_run.dashboard_id
          AND catalog.catalog_snapshot_id = v_graph.catalog_snapshot_id
        FOR KEY SHARE;
        SELECT measure.event_time_field_id INTO STRICT v_event_time_field_id
        FROM dasher.field_catalog_entries AS measure
        WHERE measure.organization_id = v_run.organization_id
          AND measure.dashboard_id = v_run.dashboard_id
          AND measure.catalog_snapshot_id = v_catalog.catalog_snapshot_id
          AND measure.field_id = v_contract.measure_field_id
          AND measure.event_time_field_id IS NOT NULL;
        SELECT latest.observed_at, latest.row_id
          INTO STRICT v_latest_observation_at,
            v_latest_observation_row_id
        FROM (
          SELECT input_value.value->>'value' AS observed_at,
            (input_row.value->>'row_id')::uuid AS row_id,
            input_row.ordinal
          FROM pg_catalog.jsonb_array_elements(
            v_request_body#>'{input_table,rows}'
          ) WITH ORDINALITY AS input_row(value, ordinal)
          JOIN LATERAL pg_catalog.jsonb_array_elements(
            input_row.value->'values'
          ) AS input_value(value)
            ON input_value.value->>'field_id' = v_event_time_field_id::text
           AND input_value.value->>'state' = 'present'
           AND input_value.value->>'type' = 'timestamp'
          ORDER BY (input_value.value->>'value')::timestamptz DESC,
            input_row.ordinal
          LIMIT 1
        ) AS latest;
        v_expected_freshness := CASE WHEN (
          extract(epoch FROM
            (v_request_body->>'evaluation_time')::timestamptz
            - v_latest_observation_at::timestamptz
          ) * 1000
        )::numeric <= v_contract.lag_millis + v_contract.freshness_slo_millis
          THEN 'current' ELSE 'stale' END;
        IF dasher_private.canonical_jsonb_bytes_v1(v_request_body) <>
            v_request.canonical_bytes
          OR dasher_private.canonical_jsonb_bytes_v1(v_graph_body) <>
            v_graph.canonical_bytes
          OR v_request.request_sha256 <> pg_catalog.sha256(
            pg_catalog.convert_to(
              'dasher.retained-payload-envelope.v1', 'UTF8'
            ) || pg_catalog.decode('00', 'hex')
            || pg_catalog.int4send(
              pg_catalog.octet_length('agent-run-request-v1')
            ) || pg_catalog.convert_to('agent-run-request-v1', 'UTF8')
            || pg_catalog.int4send(
              pg_catalog.octet_length(v_request.content_nonce)
            ) || v_request.content_nonce
            || pg_catalog.int4send(32)
            || pg_catalog.sha256(
              pg_catalog.convert_to('dasher.agent-run-request.v1', 'UTF8')
              || pg_catalog.decode('00', 'hex')
              || pg_catalog.int4send(
                pg_catalog.octet_length(v_request.canonical_bytes)
              ) || v_request.canonical_bytes
            )
          )
          OR v_source.content_sha256 <> pg_catalog.sha256(
            pg_catalog.convert_to('dasher.canonical-input-table.v1', 'UTF8')
            || pg_catalog.decode('00', 'hex')
            || pg_catalog.int4send(
              pg_catalog.octet_length(v_source.canonical_bytes)
            ) || v_source.canonical_bytes
          )
          OR v_source.canonical_bytes <> dasher_private.canonical_jsonb_bytes_v1(
            v_request_body->'input_table'
          )
          OR v_request_body->>'input_snapshot_id' <>
            v_source.snapshot_id::text
          OR v_request_body->>'input_sha256' <>
            pg_catalog.encode(v_source.content_sha256, 'hex')
          OR v_catalog.input_snapshot_id <> v_source.snapshot_id
          OR v_catalog.input_sha256 <> v_source.content_sha256
          OR v_catalog.canonical_bytes <> dasher_private.canonical_jsonb_bytes_v1(
            v_request_body->'field_catalog'
          )
          OR v_catalog.catalog_sha256 <> pg_catalog.sha256(
            pg_catalog.convert_to(
              'dasher.field-catalog-snapshot.v1', 'UTF8'
            ) || pg_catalog.decode('00', 'hex')
            || pg_catalog.int4send(
              pg_catalog.octet_length(v_catalog.canonical_bytes)
            ) || v_catalog.canonical_bytes
          )
          OR v_graph.graph_sha256 <> pg_catalog.sha256(
            pg_catalog.convert_to('dasher.calculation-graph.v1', 'UTF8')
            || pg_catalog.decode('00', 'hex')
            || pg_catalog.int4send(
              pg_catalog.octet_length(v_graph.canonical_bytes)
            ) || v_graph.canonical_bytes
          )
          OR v_graph_body->>'input_snapshot_id' <>
            v_source.snapshot_id::text
          OR v_graph_body->>'input_sha256' <>
            pg_catalog.encode(v_source.content_sha256, 'hex')
          OR v_graph_body->>'field_catalog_snapshot_id' <>
            v_catalog.catalog_snapshot_id::text
          OR v_graph_body->>'field_catalog_sha256' <>
            pg_catalog.encode(v_catalog.catalog_sha256, 'hex')
          OR v_graph_body->>'contract_set_id' <>
            v_contract.contract_set_id::text
          OR v_graph_body->>'contract_id' <> v_contract.contract_id::text
          OR v_graph_body->>'contract_version' <>
            'i64:' || v_contract.contract_version::text
          OR v_request_body#>>'{metric_contract_set,contract_set_id}' <>
            v_contract.contract_set_id::text
          OR v_request_body#>>'{metric_contract_set,contract_set_sha256}' <>
            pg_catalog.encode(v_contract.contract_set_sha256, 'hex')
          OR v_graph.freshness_source_row_id <>
            v_latest_observation_row_id
          OR v_subtree->>'latestObservationAt' <>
            v_latest_observation_at
          OR v_display <> v_expected_freshness
          OR 1 <> (
            SELECT pg_catalog.count(*)
            FROM pg_catalog.jsonb_array_elements(
              v_graph_body->'nodes'
            ) AS classifier(value)
            WHERE classifier.value->>'node_id' =
                v_graph.freshness_classifier_node_id::text
              AND classifier.value->>'op' = 'classify_state'
              AND classifier.value->>'input' =
                v_graph.freshness_input_node_id::text
              AND classifier.value->>'evaluation_time' =
                v_request_body->>'evaluation_time'
              AND classifier.value->>'stale_after_millis' = 'i64:' ||
                (v_contract.lag_millis +
                  v_contract.freshness_slo_millis)::text
          )
        THEN
          RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
        END IF;
      END IF;
      IF dasher_private.validate_calculated_claim_v1(
          v_claim_bytes, v_result.canonical_bytes
        ) IS DISTINCT FROM true
        OR (SELECT pg_catalog.count(*)
            FROM pg_catalog.jsonb_array_elements(v_body->'edges') AS edge(value)
            WHERE edge.value->>'claim_id' = v_claim.value->>'claim_id') <>
          pg_catalog.cardinality(v_lineage_ids)
        OR EXISTS (
          SELECT 1 FROM pg_catalog.unnest(v_lineage_ids) AS lineage(evidence_id)
          WHERE NOT EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_array_elements(v_body->'edges') AS edge(value)
            WHERE edge.value->>'claim_id' = v_claim.value->>'claim_id'
              AND edge.value->>'evidence_id' = lineage.evidence_id::text
              AND edge.value->>'relation' = 'supports'
          )
        )
        OR (CASE
          WHEN v_claim.value->>'json_pointer' ~
            '^/pages/[0-9]+/components/[0-9]+/claims/[0-9]+$'
          THEN v_graph.contract_output_node_id <>
              (v_claim.value->>'calculation_output_node_id')::uuid
            OR v_claim.value->>'calculation_output_identity_kind' = 'output'
            OR v_subtree->>'text' <> v_display
            OR v_subtree->'evidenceIds' <>
              pg_catalog.to_jsonb(v_lineage_ids)
          WHEN v_claim.value->>'json_pointer' ~
            '^/pages/[0-9]+/components/[0-9]+/metrics/[0-9]+$'
          THEN v_graph.contract_output_node_id <>
              (v_claim.value->>'calculation_output_node_id')::uuid
            OR v_claim.value->>'calculation_output_identity_kind' = 'output'
            OR v_subtree->>'label' <> v_contract.name
            OR v_subtree->>'value' <> v_display
            OR v_subtree ? 'change' OR v_subtree ? 'direction'
            OR v_subtree->'evidenceIds' <>
              pg_catalog.to_jsonb(v_lineage_ids)
          WHEN v_claim.value->>'json_pointer' ~
            '^/pages/[0-9]+/components/[0-9]+/items/[0-9]+$'
          THEN v_graph.contract_output_node_id <>
              (v_claim.value->>'calculation_output_node_id')::uuid
            OR v_claim.value->>'calculation_output_identity_kind' = 'output'
            OR v_subtree->>'id' <>
              v_claim.value->>'calculation_output_node_id'
            OR v_subtree->>'label' <> v_contract.name
            OR v_subtree->>'value' <> v_display
            OR v_subtree ? 'note'
            OR v_subtree->'evidenceIds' <>
              pg_catalog.to_jsonb(v_lineage_ids)
          WHEN v_claim.value->>'json_pointer' ~
            '^/executiveBrief/(known|changed|important)$'
          THEN v_graph.contract_output_node_id <>
              (v_claim.value->>'calculation_output_node_id')::uuid
            OR v_claim.value->>'calculation_output_identity_kind' = 'output'
            OR v_subtree->'statementTypes' <> '["calculated"]'::jsonb
            OR v_subtree->>'headline' <> v_contract.name
            OR v_subtree->>'detail' <> v_display
            OR v_subtree->'evidenceIds' <>
              pg_catalog.to_jsonb(v_lineage_ids)
          WHEN v_claim.value->>'json_pointer' = '/freshness'
          THEN v_graph.freshness_classifier_node_id IS NULL
            OR v_graph.freshness_classifier_node_id <>
              (v_claim.value->>'calculation_output_node_id')::uuid
            OR v_claim.value->>'calculation_output_identity_kind' = 'output'
            OR v_selected_value->>'type' <> 'text'
            OR v_display NOT IN ('current','stale')
            OR v_subtree->>'label' <> v_display
            OR v_subtree->>'status' <> CASE v_display
              WHEN 'current' THEN 'fresh' ELSE 'stale' END
          WHEN v_claim.value->>'json_pointer' ~
            '^/pages/[0-9]+/components/[0-9]+/series/[0-9]+$'
          THEN v_claim.value->>'calculation_output_identity_kind' <> 'output'
            OR v_output->>'shape' <> 'rowset'
            OR v_subtree->>'id' <>
              v_claim.value->>'calculation_output_node_id'
            OR v_subtree->>'label' <> v_contract.name
            OR v_subtree->'evidenceIds' <>
              pg_catalog.to_jsonb(v_lineage_ids)
            OR pg_catalog.jsonb_array_length(
              v_output#>'{output_type,fields}'
            ) <> 2
            OR (SELECT pg_catalog.count(*)
                FROM pg_catalog.jsonb_array_elements(
                  v_output#>'{output_type,fields}'
                ) AS field(value)
                WHERE field.value->>'name' = 'at'
                  AND field.value->>'scalar' = 'timestamp'
                  AND field.value->'nullable' = 'false'::jsonb
                  AND field.value->'unit' = 'null'::jsonb
                  AND field.value->'currency' = 'null'::jsonb) <> 1
            OR (SELECT pg_catalog.count(*)
                FROM pg_catalog.jsonb_array_elements(
                  v_output#>'{output_type,fields}'
                ) AS field(value)
                WHERE field.value->>'name' = 'value'
                  AND field.value->>'scalar' IN ('integer','decimal')
                  AND field.value->'nullable' = 'false'::jsonb
                  AND field.value->'currency' = 'null'::jsonb
                  AND field.value->'unit' IS NOT DISTINCT FROM
                    v_subtree->'unit') <> 1
            OR pg_catalog.jsonb_array_length(v_subtree->'points') <>
              pg_catalog.jsonb_array_length(v_output->'rows')
            OR EXISTS (
              SELECT 1
              FROM pg_catalog.jsonb_array_elements(v_subtree->'points')
                WITH ORDINALITY AS point(value, ordinal)
              JOIN pg_catalog.jsonb_array_elements(v_output->'rows')
                WITH ORDINALITY AS output_row(value, ordinal) USING (ordinal)
              WHERE point.value->>'at' <> (
                  SELECT cell.value#>>'{value,value}'
                  FROM pg_catalog.jsonb_array_elements(
                    output_row.value->'cells'
                  ) AS cell(value)
                  JOIN pg_catalog.jsonb_array_elements(
                    v_output#>'{output_type,fields}'
                  ) AS field(value) ON field.value->>'field_id' =
                    cell.value->>'field_id'
                  WHERE field.value->>'name' = 'at'
                )
                OR (
                  SELECT CASE
                    WHEN decoded.exponent_bits = 2047
                      OR (decoded.exponent_bits = 0
                        AND decoded.fraction_bits = 0
                        AND decoded.negative)
                      THEN NULL
                    WHEN decoded.exponent_bits = 0 THEN
                      (CASE WHEN decoded.negative THEN -1 ELSE 1 END)::numeric
                        * decoded.fraction_bits
                        * pg_catalog.power(2::numeric, -1074)
                    ELSE
                      (CASE WHEN decoded.negative THEN -1 ELSE 1 END)::numeric
                        * (pg_catalog.power(2::numeric, 52)
                          + decoded.fraction_bits)
                        * pg_catalog.power(
                          2::numeric, decoded.exponent_bits - 1075
                        )
                  END
                  FROM (SELECT pg_catalog.float8send(
                    (point.value->>'value')::double precision
                  ) AS bytes) AS raw
                  CROSS JOIN LATERAL (SELECT
                    (pg_catalog.get_byte(raw.bytes, 0) & 128) <> 0 AS negative,
                    (pg_catalog.get_byte(raw.bytes, 0) & 127) * 16
                      + (pg_catalog.get_byte(raw.bytes, 1) >> 4)
                        AS exponent_bits,
                    ((pg_catalog.get_byte(raw.bytes, 1) & 15)::numeric
                        * pg_catalog.power(2::numeric, 48))
                      + (pg_catalog.get_byte(raw.bytes, 2)::numeric
                        * pg_catalog.power(2::numeric, 40))
                      + (pg_catalog.get_byte(raw.bytes, 3)::numeric
                        * pg_catalog.power(2::numeric, 32))
                      + (pg_catalog.get_byte(raw.bytes, 4)::numeric
                        * pg_catalog.power(2::numeric, 24))
                      + (pg_catalog.get_byte(raw.bytes, 5)::numeric
                        * pg_catalog.power(2::numeric, 16))
                      + (pg_catalog.get_byte(raw.bytes, 6)::numeric * 256)
                      + pg_catalog.get_byte(raw.bytes, 7)::numeric
                        AS fraction_bits
                  ) AS decoded
                ) IS DISTINCT FROM (
                  SELECT CASE cell.value#>>'{value,type}'
                    WHEN 'integer' THEN pg_catalog.substr(
                      cell.value#>>'{value,value}', 5
                    )::numeric
                    ELSE (cell.value#>>'{value,value,coefficient}')::numeric
                      / pg_catalog.power(10::numeric, pg_catalog.substr(
                        cell.value#>>'{value,value,scale}', 5
                      )::numeric) END
                  FROM pg_catalog.jsonb_array_elements(
                    output_row.value->'cells'
                  ) AS cell(value)
                  JOIN pg_catalog.jsonb_array_elements(
                    v_output#>'{output_type,fields}'
                  ) AS field(value) ON field.value->>'field_id' =
                    cell.value->>'field_id'
                  WHERE field.value->>'name' = 'value'
                )
            )
          ELSE true END)
      THEN
        RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
      END IF;
    END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(v_body->'edges') AS edge(value)
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_catalog.jsonb_array_elements(v_body->'claims') AS claim(value)
      WHERE claim.value->>'claim_id' = edge.value->>'claim_id'
    ) OR NOT EXISTS (
      SELECT 1
      FROM dasher.candidate_comparison_bundle_evidence AS member
      WHERE member.organization_id = v_run.organization_id
        AND member.dashboard_id = v_run.dashboard_id
        AND member.run_id = v_run.run_id
        AND member.bundle_id = v_candidate.common_bundle_id
        AND member.evidence_id = (edge.value->>'evidence_id')::uuid
    )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  IF EXISTS (
    SELECT 1 FROM dasher.claims AS claim
    WHERE claim.organization_id = v_run.organization_id
      AND claim.dashboard_id = v_run.dashboard_id AND claim.run_id = v_run.run_id
      AND claim.candidate_id = p_candidate_id
  ) THEN
    SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'claim_id', claim.claim_id::text,
        'json_pointer', claim.json_pointer,
        'assertion_sha256', pg_catalog.encode(claim.assertion_sha256, 'hex'),
        'label', claim.label, 'statement', claim.statement,
        'salience', claim.salience, 'evidence_state', claim.evidence_state,
        'calculation_result_id', pg_catalog.to_jsonb(claim.calculation_result_id),
        'calculation_output_identity_kind',
          pg_catalog.to_jsonb(claim.calculation_output_identity_kind),
        'calculation_output_node_id',
          pg_catalog.to_jsonb(claim.calculation_output_node_id),
        'calculation_output_sha256', CASE
          WHEN claim.calculation_output_sha256 IS NULL THEN 'null'::jsonb
          ELSE pg_catalog.to_jsonb(pg_catalog.encode(
            claim.calculation_output_sha256, 'hex'
          )) END,
        'calculation_output_row_id',
          pg_catalog.to_jsonb(claim.calculation_output_row_id),
        'calculation_output_field_id',
          pg_catalog.to_jsonb(claim.calculation_output_field_id),
        'calculation_output_value_sha256', CASE
          WHEN claim.calculation_output_value_sha256 IS NULL THEN 'null'::jsonb
          ELSE pg_catalog.to_jsonb(pg_catalog.encode(
            claim.calculation_output_value_sha256, 'hex'
          )) END
      ) ORDER BY pg_catalog.uuid_send(claim.claim_id)), '[]'::jsonb)
      INTO v_existing_claims
    FROM dasher.claims AS claim
    WHERE claim.organization_id = v_run.organization_id
      AND claim.dashboard_id = v_run.dashboard_id
      AND claim.run_id = v_run.run_id
      AND claim.candidate_id = p_candidate_id;
    SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'claim_id', edge.claim_id::text,
        'evidence_id', edge.evidence_id::text,
        'relation', edge.relation
      ) ORDER BY pg_catalog.uuid_send(edge.claim_id),
        pg_catalog.uuid_send(edge.evidence_id),
        pg_catalog.array_position(
          ARRAY['supports','contradicts','context'], edge.relation
        )), '[]'::jsonb)
      INTO v_existing_edges
    FROM dasher.claim_evidence AS edge
    WHERE edge.organization_id = v_run.organization_id
      AND edge.dashboard_id = v_run.dashboard_id
      AND edge.run_id = v_run.run_id
      AND edge.candidate_id = p_candidate_id;
    IF v_existing_claims <> v_body->'claims'
      OR v_existing_edges <> v_body->'edges'
      OR EXISTS (
        SELECT 1 FROM dasher.claims AS claim
        WHERE claim.organization_id = v_run.organization_id
          AND claim.dashboard_id = v_run.dashboard_id
          AND claim.run_id = v_run.run_id
          AND claim.candidate_id = p_candidate_id
          AND claim.claim_set_sha256 <> v_sha
      )
      OR NOT EXISTS (
        SELECT 1
        FROM dasher.agent_run_events AS event
        JOIN dasher.claims AS claim
          ON claim.organization_id = event.organization_id
         AND claim.dashboard_id = event.dashboard_id
         AND claim.run_id = event.run_id
         AND claim.candidate_id = p_candidate_id
        WHERE event.organization_id = v_run.organization_id
          AND event.dashboard_id = v_run.dashboard_id
          AND event.run_id = v_run.run_id
          AND event.event_kind = 'candidate_claims_committed'
          AND event.occurred_at = claim.created_at
      )
    THEN
      RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
    END IF;
    RETURN ROW(
      ROW(v_run.run_id, v_run.run_revision, v_run.state,
        v_run.current_event_sequence, v_run.current_event_sha256,
        v_run.lease_epoch)::dasher_run_api.run_mutation_result,
      p_candidate_id, v_claim_count, v_edge_count, v_sha
    )::dasher_run_api.claim_set_result;
  END IF;
  INSERT INTO dasher.claims (
    organization_id, dashboard_id, run_id, candidate_id, claim_id,
    json_pointer, assertion_sha256, label, statement, salience,
    evidence_state, calculation_result_id, calculation_output_identity_kind,
    calculation_output_node_id, calculation_output_sha256,
    calculation_output_row_id, calculation_output_field_id,
    calculation_output_value_sha256, claim_set_sha256, claim_sha256, created_at
  )
  SELECT v_run.organization_id, v_run.dashboard_id, v_run.run_id, p_candidate_id,
    (item.value->>'claim_id')::uuid, item.value->>'json_pointer',
    pg_catalog.decode(item.value->>'assertion_sha256', 'hex'),
    item.value->>'label', item.value->>'statement', item.value->>'salience',
    item.value->>'evidence_state',
    NULLIF(item.value->>'calculation_result_id', '')::uuid,
    NULLIF(item.value->>'calculation_output_identity_kind', ''),
    NULLIF(item.value->>'calculation_output_node_id', '')::uuid,
    CASE WHEN item.value ? 'calculation_output_sha256'
      THEN pg_catalog.decode(item.value->>'calculation_output_sha256', 'hex') ELSE NULL END,
    NULLIF(item.value->>'calculation_output_row_id', '')::uuid,
    NULLIF(item.value->>'calculation_output_field_id', '')::uuid,
    CASE WHEN item.value ? 'calculation_output_value_sha256'
      THEN pg_catalog.decode(item.value->>'calculation_output_value_sha256', 'hex') ELSE NULL END,
    v_sha,
    pg_catalog.sha256(
      pg_catalog.convert_to('dasher.candidate-claim.v1', 'UTF8')
      || pg_catalog.decode('00', 'hex')
      || pg_catalog.int4send(pg_catalog.octet_length(
        dasher_private.canonical_jsonb_bytes_v1(item.value)
      ))
      || dasher_private.canonical_jsonb_bytes_v1(item.value)
    ),
    pg_catalog.statement_timestamp()
  FROM pg_catalog.jsonb_array_elements(v_body->'claims') WITH ORDINALITY
    AS item(value, ordinal)
  ORDER BY item.ordinal;
  IF (SELECT pg_catalog.count(*) FROM dasher.claims AS claim
      WHERE claim.organization_id = v_run.organization_id
        AND claim.dashboard_id = v_run.dashboard_id AND claim.run_id = v_run.run_id
        AND claim.candidate_id = p_candidate_id) <> v_claim_count
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  INSERT INTO dasher.claim_evidence (
    organization_id, dashboard_id, run_id, candidate_id, claim_id,
    bundle_id, evidence_id, relation
  )
  SELECT v_run.organization_id, v_run.dashboard_id, v_run.run_id, p_candidate_id,
    (edge.value->>'claim_id')::uuid, v_candidate.common_bundle_id,
    (edge.value->>'evidence_id')::uuid, edge.value->>'relation'
  FROM pg_catalog.jsonb_array_elements(v_body->'edges') WITH ORDINALITY
    AS edge(value, ordinal)
  JOIN dasher.claims AS claim
    ON claim.organization_id = v_run.organization_id
   AND claim.dashboard_id = v_run.dashboard_id AND claim.run_id = v_run.run_id
   AND claim.candidate_id = p_candidate_id
   AND claim.claim_id = (edge.value->>'claim_id')::uuid
  JOIN dasher.candidate_comparison_bundle_evidence AS member
    ON member.organization_id = v_run.organization_id
   AND member.dashboard_id = v_run.dashboard_id AND member.run_id = v_run.run_id
   AND member.bundle_id = v_candidate.common_bundle_id
   AND member.evidence_id = (edge.value->>'evidence_id')::uuid
  ORDER BY edge.ordinal;
  IF (SELECT pg_catalog.count(*) FROM dasher.claim_evidence AS edge
      WHERE edge.organization_id = v_run.organization_id
        AND edge.dashboard_id = v_run.dashboard_id AND edge.run_id = v_run.run_id
        AND edge.candidate_id = p_candidate_id) <> v_edge_count
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  v_mutation := dasher_private.append_agent_run_event_v1(
    v_run.run_id, dasher_private.uuid_v8_from_sha256_v1(pg_catalog.convert_to(pg_catalog.clock_timestamp()::text || '|' || pg_catalog.txid_current()::text || '|' || pg_catalog.random()::text, 'UTF8')), 'candidate_claims_committed',
    pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'candidate_id', p_candidate_id::text, 'claim_count', 'i64:' || v_claim_count::text,
      'claims_sha256', pg_catalog.encode(v_sha, 'hex'),
      'edge_count', 'i64:' || v_edge_count::text
    )::text, 'UTF8')
  );
  RETURN ROW(v_mutation, p_candidate_id, v_claim_count, v_edge_count, v_sha)
    ::dasher_run_api.claim_set_result;
END
$function$;

CREATE OR REPLACE FUNCTION dasher_run_api.commit_candidate_manifest(
  p_run_id uuid,
  p_lease_epoch bigint,
  p_attempt_token bytea,
  p_candidate_id uuid,
  p_canonical_manifest_bytes bytea,
  p_reviewer_result_sha256 bytea
)
RETURNS dasher_run_api.content_commit_result
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_run dasher.agent_runs%ROWTYPE;
  v_candidate dasher.agent_candidates%ROWTYPE;
  v_discovered_candidate dasher.agent_candidates%ROWTYPE;
  v_candidate_payload dasher.agent_candidate_payloads%ROWTYPE;
  v_bundle dasher.candidate_comparison_bundles%ROWTYPE;
  v_findings dasher.agent_validation_findings%ROWTYPE;
  v_reviewer_result dasher.agent_recorded_results%ROWTYPE;
  v_body jsonb;
  v_reviewer_body jsonb;
  v_sha bytea;
  v_reviewer_result_id uuid;
  v_claim_set_sha bytea;
  v_entry record;
  v_existing dasher.candidate_evidence_manifests%ROWTYPE;
  v_mutation dasher_run_api.run_mutation_result;
BEGIN
  IF p_candidate_id IS NULL OR pg_catalog.octet_length(p_reviewer_result_sha256) <> 32
    OR p_canonical_manifest_bytes IS NULL
    OR pg_catalog.octet_length(p_canonical_manifest_bytes) NOT BETWEEN 1 AND 65536
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  BEGIN
    v_body := pg_catalog.convert_from(p_canonical_manifest_bytes, 'UTF8')::jsonb;
  EXCEPTION WHEN character_not_in_repertoire OR invalid_text_representation THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END;
  IF dasher_private.canonical_jsonb_bytes_v1(v_body)
      IS DISTINCT FROM p_canonical_manifest_bytes
    OR pg_catalog.jsonb_typeof(v_body) <> 'object'
    OR (SELECT pg_catalog.count(*)
        FROM pg_catalog.jsonb_object_keys(v_body)) <> 9
    OR NOT v_body ?& ARRAY[
      'schema','candidate_id','candidate_spec_sha256','bundle_sha256',
      'claims_sha256','validation_findings_sha256',
      'reviewer_verdict_sha256','material_claim_set_sha256','entries'
    ]
    OR v_body->>'schema' <> 'candidate-evidence-manifest-v1'
    OR v_body->>'candidate_id' !~
      '^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR (v_body->>'candidate_id')::uuid <> p_candidate_id
    OR pg_catalog.jsonb_typeof(v_body->'entries') <> 'array'
    OR pg_catalog.jsonb_array_length(v_body->'entries') NOT BETWEEN 1 AND 64
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  v_sha := pg_catalog.sha256(
    pg_catalog.convert_to('dasher.candidate-evidence-manifest.v1', 'UTF8')
    || pg_catalog.decode('00', 'hex')
    || pg_catalog.int4send(pg_catalog.octet_length(p_canonical_manifest_bytes))
    || p_canonical_manifest_bytes
  );
  PERFORM dasher_private.initialize_run_operator_context_v1(p_run_id, 'commit_manifest');
  PERFORM dasher_private.reauthorize_agent_run_v1(p_run_id, p_lease_epoch, p_attempt_token);
  IF NULLIF(current_setting(
    'dasher.run_replay_source_id', true
  ), '') IS NOT NULL THEN
    PERFORM dasher_private.replay_source_fence_v1(
      NULLIF(current_setting('dasher.run_organization_id', true), '')::uuid,
      NULLIF(current_setting('dasher.run_replay_source_id', true), '')::uuid
    );
    PERFORM pg_catalog.set_config('dasher.run_phase', 'authorized', true);
  END IF;
  SELECT run.* INTO STRICT v_run FROM dasher.agent_runs AS run
  WHERE run.organization_id = current_setting('dasher.run_organization_id', true)::uuid
    AND run.run_id = p_run_id FOR UPDATE;
  SELECT candidate.* INTO STRICT v_discovered_candidate
  FROM dasher.agent_candidates AS candidate
  WHERE candidate.organization_id = v_run.organization_id
    AND candidate.dashboard_id = v_run.dashboard_id AND candidate.run_id = v_run.run_id
    AND candidate.candidate_id = p_candidate_id;
  SELECT bundle.* INTO STRICT v_bundle
  FROM dasher.candidate_comparison_bundles AS bundle
  WHERE bundle.organization_id = v_discovered_candidate.organization_id
    AND bundle.dashboard_id = v_discovered_candidate.dashboard_id
    AND bundle.run_id = v_discovered_candidate.run_id
    AND bundle.bundle_id = v_discovered_candidate.common_bundle_id
  FOR UPDATE;
  SELECT candidate.* INTO STRICT v_candidate
  FROM dasher.agent_candidates AS candidate
  WHERE candidate.organization_id = v_discovered_candidate.organization_id
    AND candidate.dashboard_id = v_discovered_candidate.dashboard_id
    AND candidate.run_id = v_discovered_candidate.run_id
    AND candidate.candidate_id = v_discovered_candidate.candidate_id
  FOR UPDATE;
  IF v_candidate IS DISTINCT FROM v_discovered_candidate THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;
  SELECT payload.* INTO STRICT v_candidate_payload
  FROM dasher.agent_candidate_payloads AS payload
  WHERE payload.organization_id = v_candidate.organization_id
    AND payload.dashboard_id = v_candidate.dashboard_id
    AND payload.run_id = v_candidate.run_id
    AND payload.candidate_id = v_candidate.candidate_id;
  SELECT finding.* INTO STRICT v_findings
  FROM dasher.agent_validation_findings AS finding
  WHERE finding.organization_id = v_candidate.organization_id
    AND finding.dashboard_id = v_candidate.dashboard_id
    AND finding.run_id = v_candidate.run_id
    AND finding.candidate_id = v_candidate.candidate_id;
  SELECT result.* INTO STRICT v_reviewer_result
  FROM dasher.agent_recorded_results AS result
  WHERE result.organization_id = v_run.organization_id
    AND result.dashboard_id = v_run.dashboard_id AND result.run_id = v_run.run_id
    AND result.result_kind = 'reviewer_verdict_set'
    AND result.result_sha256 = p_reviewer_result_sha256;
  v_reviewer_result_id := v_reviewer_result.result_id;
  v_reviewer_body := pg_catalog.convert_from(
    v_reviewer_result.canonical_bytes, 'UTF8'
  )::jsonb;
  SELECT claim.claim_set_sha256 INTO STRICT v_claim_set_sha
  FROM dasher.claims AS claim
  WHERE claim.organization_id = v_candidate.organization_id
    AND claim.dashboard_id = v_candidate.dashboard_id
    AND claim.run_id = v_candidate.run_id
    AND claim.candidate_id = v_candidate.candidate_id
  LIMIT 1;
  IF v_candidate.validation_state <> 'valid'
    OR dasher_private.validate_candidate_claim_rows_v1(
      v_candidate.organization_id, v_candidate.dashboard_id,
      v_candidate.run_id, v_candidate.candidate_id, true
    ) IS DISTINCT FROM true
    OR dasher_private.extract_material_assertions_v1(
      v_candidate_payload.canonical_bytes, v_candidate.candidate_spec_sha256
    ) IS NULL
    OR v_body->>'candidate_spec_sha256' <> pg_catalog.encode(v_candidate.candidate_spec_sha256, 'hex')
    OR v_body->>'bundle_sha256' <> pg_catalog.encode(v_bundle.bundle_sha256, 'hex')
    OR v_body->>'claims_sha256' <> pg_catalog.encode(v_claim_set_sha, 'hex')
    OR v_body->>'validation_findings_sha256' <>
      pg_catalog.encode(v_findings.findings_sha256, 'hex')
    OR v_body->>'reviewer_verdict_sha256' <>
      pg_catalog.encode(p_reviewer_result_sha256, 'hex')
    OR v_body->>'material_claim_set_sha256' <> pg_catalog.encode(v_candidate.material_claim_set_sha256, 'hex')
    OR pg_catalog.jsonb_array_length(v_body->'entries') <>
      v_candidate.material_claim_count
    OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.jsonb_array_elements(
        v_reviewer_body#>'{result,verdicts}'
      ) AS verdict(value)
      WHERE verdict.value->>'candidate_id' = p_candidate_id::text
        AND verdict.value->>'candidate_spec_sha256' =
          pg_catalog.encode(v_candidate.candidate_spec_sha256, 'hex')
        AND verdict.value->>'verdict' IN ('preferred','acceptable')
    )
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  FOR v_entry IN
    SELECT entry.value, entry.ordinal
    FROM pg_catalog.jsonb_array_elements(v_body->'entries') WITH ORDINALITY
      AS entry(value, ordinal)
    ORDER BY entry.ordinal
  LOOP
    IF pg_catalog.jsonb_typeof(v_entry.value) <> 'object'
      OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(
        v_entry.value
      )) <> 2
      OR NOT v_entry.value ?& ARRAY['claim_id','supporting_evidence_ids']
      OR v_entry.value->>'claim_id' !~
        '^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      OR pg_catalog.jsonb_typeof(
        v_entry.value->'supporting_evidence_ids'
      ) <> 'array'
      OR EXISTS (
        SELECT 1 FROM pg_catalog.jsonb_array_elements(v_body->'entries')
          WITH ORDINALITY AS prior(value, ordinal)
        WHERE prior.ordinal = v_entry.ordinal - 1
          AND pg_catalog.uuid_send((prior.value->>'claim_id')::uuid) >=
            pg_catalog.uuid_send((v_entry.value->>'claim_id')::uuid)
      )
      OR NOT EXISTS (
        SELECT 1 FROM dasher.claims AS claim
        WHERE claim.organization_id = v_candidate.organization_id
          AND claim.dashboard_id = v_candidate.dashboard_id
          AND claim.run_id = v_candidate.run_id
          AND claim.candidate_id = v_candidate.candidate_id
          AND claim.claim_id = (v_entry.value->>'claim_id')::uuid
      )
      OR v_entry.value->'supporting_evidence_ids' <> COALESCE((
        SELECT pg_catalog.jsonb_agg(edge.evidence_id::text
          ORDER BY pg_catalog.uuid_send(edge.evidence_id))
        FROM dasher.claim_evidence AS edge
        WHERE edge.organization_id = v_candidate.organization_id
          AND edge.dashboard_id = v_candidate.dashboard_id
          AND edge.run_id = v_candidate.run_id
          AND edge.candidate_id = v_candidate.candidate_id
          AND edge.claim_id = (v_entry.value->>'claim_id')::uuid
          AND edge.relation = 'supports'
      ), '[]'::jsonb)
    THEN
      RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
    END IF;
  END LOOP;
  SELECT manifest.* INTO v_existing
  FROM dasher.candidate_evidence_manifests AS manifest
  WHERE manifest.organization_id = v_run.organization_id
    AND manifest.dashboard_id = v_run.dashboard_id AND manifest.run_id = v_run.run_id
    AND manifest.candidate_id = p_candidate_id;
  IF FOUND THEN
    IF v_existing.manifest_sha256 <> v_sha
      OR v_existing.reviewer_result_sha256 <> p_reviewer_result_sha256
      OR v_existing.reviewer_result_id <> v_reviewer_result_id
      OR v_existing.canonical_bytes <> p_canonical_manifest_bytes
    THEN
      RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
    END IF;
    RETURN ROW(
      ROW(v_run.run_id, v_run.run_revision, v_run.state,
        v_run.current_event_sequence, v_run.current_event_sha256,
        v_run.lease_epoch)::dasher_run_api.run_mutation_result,
      p_candidate_id, v_sha
    )::dasher_run_api.content_commit_result;
  END IF;
  INSERT INTO dasher.candidate_evidence_manifests (
    organization_id, dashboard_id, run_id, candidate_id, reviewer_result_id,
    reviewer_result_sha256, manifest_sha256, canonical_bytes, created_at
  ) VALUES (
    v_run.organization_id, v_run.dashboard_id, v_run.run_id, p_candidate_id,
    v_reviewer_result_id, p_reviewer_result_sha256, v_sha,
    p_canonical_manifest_bytes, pg_catalog.statement_timestamp()
  );
  UPDATE dasher.agent_candidates AS candidate
  SET review_state = 'approved', manifest_sha256 = v_sha
  WHERE candidate.organization_id = v_run.organization_id
    AND candidate.dashboard_id = v_run.dashboard_id AND candidate.run_id = v_run.run_id
    AND candidate.candidate_id = p_candidate_id;
  v_mutation := dasher_private.append_agent_run_event_v1(
    v_run.run_id, dasher_private.uuid_v8_from_sha256_v1(pg_catalog.convert_to(pg_catalog.clock_timestamp()::text || '|' || pg_catalog.txid_current()::text || '|' || pg_catalog.random()::text, 'UTF8')), 'candidate_manifest_committed',
    pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'candidate_id', p_candidate_id::text,
      'manifest_sha256', pg_catalog.encode(v_sha, 'hex'),
      'reviewer_result_sha256', pg_catalog.encode(p_reviewer_result_sha256, 'hex')
    )::text, 'UTF8')
  );
  RETURN ROW(v_mutation, p_candidate_id, v_sha)
    ::dasher_run_api.content_commit_result;
END
$function$;

CREATE OR REPLACE FUNCTION dasher_run_api.commit_run_abstention(
  p_run_id uuid,
  p_lease_epoch bigint,
  p_attempt_token bytea,
  p_terminal_operation_id uuid,
  p_canonical_abstention_bytes bytea
)
RETURNS dasher_run_api.content_commit_result
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_run dasher.agent_runs%ROWTYPE;
  v_body jsonb;
  v_sha bytea;
  v_abstention_id uuid;
  v_existing dasher.run_abstentions%ROWTYPE;
  v_mutation dasher_run_api.run_mutation_result;
BEGIN
  IF p_terminal_operation_id IS NULL OR p_canonical_abstention_bytes IS NULL
    OR pg_catalog.octet_length(p_canonical_abstention_bytes) NOT BETWEEN 1 AND 4096
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  BEGIN
    v_body := pg_catalog.convert_from(p_canonical_abstention_bytes, 'UTF8')::jsonb;
  EXCEPTION WHEN character_not_in_repertoire OR invalid_text_representation THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END;
  IF v_body->>'schema' <> 'run-abstention-v1'
    OR v_body->>'reason' NOT IN (
      'insufficient_evidence', 'ambiguous_request', 'missing_governed_metric',
      'unsupported_capability', 'calculation_limit', 'budget_exhausted',
      'authority_revoked'
    )
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  v_abstention_id := (v_body->>'abstention_id')::uuid;
  v_sha := pg_catalog.sha256(
    pg_catalog.convert_to('dasher.run-abstention.v1', 'UTF8')
    || pg_catalog.decode('00', 'hex')
    || pg_catalog.int4send(pg_catalog.octet_length(p_canonical_abstention_bytes))
    || p_canonical_abstention_bytes
  );
  PERFORM dasher_private.initialize_run_operator_context_v1(p_run_id, 'commit_abstention');
  PERFORM dasher_private.reauthorize_agent_run_v1(p_run_id, p_lease_epoch, p_attempt_token);
  IF NULLIF(current_setting(
    'dasher.run_replay_source_id', true
  ), '') IS NOT NULL THEN
    PERFORM dasher_private.replay_source_fence_v1(
      NULLIF(current_setting('dasher.run_organization_id', true), '')::uuid,
      NULLIF(current_setting('dasher.run_replay_source_id', true), '')::uuid
    );
    PERFORM pg_catalog.set_config('dasher.run_phase', 'authorized', true);
  END IF;
  SELECT run.* INTO STRICT v_run FROM dasher.agent_runs AS run
  WHERE run.organization_id = current_setting('dasher.run_organization_id', true)::uuid
    AND run.run_id = p_run_id FOR UPDATE;
  SELECT abstention.* INTO v_existing FROM dasher.run_abstentions AS abstention
  WHERE abstention.organization_id = v_run.organization_id
    AND abstention.dashboard_id = v_run.dashboard_id AND abstention.run_id = v_run.run_id;
  IF FOUND THEN
    IF v_existing.abstention_id <> v_abstention_id OR v_existing.abstention_sha256 <> v_sha
      OR v_run.terminal_operation_id <> p_terminal_operation_id
    THEN
      RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
    END IF;
    RETURN ROW(
      ROW(v_run.run_id, v_run.run_revision, v_run.state,
        v_run.current_event_sequence, v_run.current_event_sha256,
        v_run.lease_epoch)::dasher_run_api.run_mutation_result,
      v_abstention_id, v_sha
    )::dasher_run_api.content_commit_result;
  END IF;
  IF EXISTS (
    SELECT 1 FROM dasher.agent_run_attempts AS attempt
    WHERE attempt.organization_id = v_run.organization_id
      AND attempt.dashboard_id = v_run.dashboard_id AND attempt.run_id = v_run.run_id
      AND attempt.state IN ('reserved_pre_dispatch', 'dispatch_ready', 'dispatch_started')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  INSERT INTO dasher.run_abstentions (
    organization_id, dashboard_id, run_id, abstention_id, abstention_sha256,
    canonical_bytes, created_at
  ) VALUES (
    v_run.organization_id, v_run.dashboard_id, v_run.run_id, v_abstention_id,
    v_sha, p_canonical_abstention_bytes, pg_catalog.statement_timestamp()
  );
  PERFORM pg_catalog.set_config('dasher.run_next_state', 'rejected', true);
  PERFORM pg_catalog.set_config('dasher.run_clear_lease', 'true', true);
  PERFORM pg_catalog.set_config('dasher.run_terminal_operation_kind', 'abstention', true);
  PERFORM pg_catalog.set_config('dasher.run_terminal_operation_id', p_terminal_operation_id::text, true);
  PERFORM pg_catalog.set_config('dasher.run_terminal_reason_sha256', pg_catalog.encode(v_sha, 'hex'), true);
  v_mutation := dasher_private.append_agent_run_event_v1(
    v_run.run_id, dasher_private.uuid_v8_from_sha256_v1(pg_catalog.convert_to(pg_catalog.clock_timestamp()::text || '|' || pg_catalog.txid_current()::text || '|' || pg_catalog.random()::text, 'UTF8')), 'run_abstained',
    pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'abstention_id', v_abstention_id::text,
      'abstention_sha256', pg_catalog.encode(v_sha, 'hex'),
      'terminal_operation_id', p_terminal_operation_id::text
    )::text, 'UTF8')
  );
  RETURN ROW(v_mutation, v_abstention_id, v_sha)
    ::dasher_run_api.content_commit_result;
END
$function$;

CREATE OR REPLACE FUNCTION dasher_run_api.finalize_agent_run_ranking(
  p_run_id uuid,
  p_lease_epoch bigint,
  p_attempt_token bytea,
  p_terminal_operation_id uuid,
  p_selected_candidate_id uuid,
  p_ranking_proof_sha256 bytea
)
RETURNS dasher_run_api.ranking_result
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_run dasher.agent_runs%ROWTYPE;
  v_bundle dasher.candidate_comparison_bundles%ROWTYPE;
  v_ids uuid[];
  v_ranks integer[];
  v_expected bytea;
  v_preimage bytea;
  v_ranked record;
  v_mutation dasher_run_api.run_mutation_result;
BEGIN
  IF p_terminal_operation_id IS NULL OR p_selected_candidate_id IS NULL
    OR pg_catalog.octet_length(p_ranking_proof_sha256) <> 32
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  PERFORM dasher_private.initialize_run_operator_context_v1(p_run_id, 'finalize_ranking');
  PERFORM dasher_private.reauthorize_agent_run_v1(p_run_id, p_lease_epoch, p_attempt_token);
  IF NULLIF(current_setting(
    'dasher.run_replay_source_id', true
  ), '') IS NOT NULL THEN
    PERFORM dasher_private.replay_source_fence_v1(
      NULLIF(current_setting('dasher.run_organization_id', true), '')::uuid,
      NULLIF(current_setting('dasher.run_replay_source_id', true), '')::uuid
    );
    PERFORM pg_catalog.set_config('dasher.run_phase', 'authorized', true);
  END IF;
  SELECT run.* INTO STRICT v_run FROM dasher.agent_runs AS run
  WHERE run.organization_id = current_setting('dasher.run_organization_id', true)::uuid
    AND run.run_id = p_run_id FOR UPDATE;
  SELECT bundle.* INTO STRICT v_bundle
  FROM dasher.candidate_comparison_bundles AS bundle
  WHERE bundle.organization_id = v_run.organization_id
    AND bundle.dashboard_id = v_run.dashboard_id
    AND bundle.run_id = v_run.run_id
  FOR UPDATE;
  WITH eligible AS (
    SELECT candidate.candidate_id, candidate.candidate_spec_sha256,
      CASE verdict.value->>'verdict'
        WHEN 'preferred' THEN 0 ELSE 1 END AS review_ordinal,
      (SELECT pg_catalog.count(*) FROM dasher.claims AS claim
       WHERE claim.organization_id = candidate.organization_id
         AND claim.dashboard_id = candidate.dashboard_id
         AND claim.run_id = candidate.run_id
         AND claim.candidate_id = candidate.candidate_id
         AND claim.evidence_state = 'contradicted') AS contradicted_count,
      (SELECT pg_catalog.count(*) FROM dasher.claims AS claim
       WHERE claim.organization_id = candidate.organization_id
         AND claim.dashboard_id = candidate.dashboard_id
         AND claim.run_id = candidate.run_id
         AND claim.candidate_id = candidate.candidate_id
         AND (claim.evidence_state IN ('partial','stale','unsupported')
           OR claim.label IN ('unknown','blocked'))) AS weak_count,
      (SELECT pg_catalog.count(*) FROM dasher.claims AS claim
       WHERE claim.organization_id = candidate.organization_id
         AND claim.dashboard_id = candidate.dashboard_id
         AND claim.run_id = candidate.run_id
         AND claim.candidate_id = candidate.candidate_id
         AND claim.evidence_state = 'complete'
         AND EXISTS (
           SELECT 1 FROM dasher.claim_evidence AS edge
           JOIN dasher.candidate_comparison_bundle_evidence AS member
             ON member.organization_id = edge.organization_id
            AND member.dashboard_id = edge.dashboard_id
            AND member.run_id = edge.run_id
            AND member.bundle_id = edge.bundle_id
            AND member.evidence_id = edge.evidence_id
            AND member.freshness = 'current'
           WHERE edge.organization_id = claim.organization_id
             AND edge.dashboard_id = claim.dashboard_id
             AND edge.run_id = claim.run_id
             AND edge.candidate_id = claim.candidate_id
             AND edge.claim_id = claim.claim_id
             AND edge.relation = 'supports'
         )) AS complete_supported_count
    FROM dasher.agent_candidates AS candidate
    JOIN dasher.candidate_evidence_manifests AS manifest
      ON manifest.organization_id = candidate.organization_id
     AND manifest.dashboard_id = candidate.dashboard_id
     AND manifest.run_id = candidate.run_id
     AND manifest.candidate_id = candidate.candidate_id
    JOIN dasher.agent_recorded_results AS reviewer
      ON reviewer.organization_id = manifest.organization_id
     AND reviewer.dashboard_id = manifest.dashboard_id
     AND reviewer.run_id = manifest.run_id
     AND reviewer.result_id = manifest.reviewer_result_id
     AND reviewer.result_sha256 = manifest.reviewer_result_sha256
     AND reviewer.result_kind = 'reviewer_verdict_set'
    CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(
      pg_catalog.convert_from(reviewer.canonical_bytes, 'UTF8')::jsonb
        #>'{result,verdicts}'
    ) AS verdict(value)
    WHERE candidate.organization_id = v_run.organization_id
      AND candidate.dashboard_id = v_run.dashboard_id
      AND candidate.run_id = v_run.run_id
      AND candidate.validation_state = 'valid'
      AND candidate.review_state = 'approved'
      AND candidate.manifest_sha256 = manifest.manifest_sha256
      AND verdict.value->>'candidate_id' = candidate.candidate_id::text
      AND verdict.value->>'candidate_spec_sha256' =
        pg_catalog.encode(candidate.candidate_spec_sha256, 'hex')
      AND verdict.value->>'verdict' IN ('preferred','acceptable')
      AND dasher_private.validate_candidate_claim_rows_v1(
        candidate.organization_id, candidate.dashboard_id,
        candidate.run_id, candidate.candidate_id, true
      )
      AND NOT EXISTS (
        SELECT 1 FROM dasher.claims AS claim
        WHERE claim.organization_id = candidate.organization_id
          AND claim.dashboard_id = candidate.dashboard_id
          AND claim.run_id = candidate.run_id
          AND claim.candidate_id = candidate.candidate_id
          AND (claim.evidence_state = 'contradicted'
            OR (claim.label IN ('observed','calculated') AND (
              claim.evidence_state <> 'complete' OR NOT EXISTS (
                SELECT 1 FROM dasher.claim_evidence AS edge
                JOIN dasher.candidate_comparison_bundle_evidence AS member
                  ON member.organization_id = edge.organization_id
                 AND member.dashboard_id = edge.dashboard_id
                 AND member.run_id = edge.run_id
                 AND member.bundle_id = edge.bundle_id
                 AND member.evidence_id = edge.evidence_id
                 AND member.freshness = 'current'
                WHERE edge.organization_id = claim.organization_id
                  AND edge.dashboard_id = claim.dashboard_id
                  AND edge.run_id = claim.run_id
                  AND edge.candidate_id = claim.candidate_id
                  AND edge.claim_id = claim.claim_id
                  AND edge.relation = 'supports'
              )
            )))
      )
  ), ranked AS (
    SELECT eligible.*,
      pg_catalog.row_number() OVER (ORDER BY
        eligible.review_ordinal, eligible.contradicted_count,
        eligible.weak_count, eligible.complete_supported_count DESC,
        eligible.candidate_spec_sha256,
        pg_catalog.uuid_send(eligible.candidate_id)
      )::integer AS rank
    FROM eligible
  )
  SELECT pg_catalog.array_agg(ranked.candidate_id ORDER BY ranked.rank),
      pg_catalog.array_agg(ranked.rank ORDER BY ranked.rank)
    INTO v_ids, v_ranks
  FROM ranked;
  IF pg_catalog.cardinality(v_ids) NOT BETWEEN 1 AND 2
    OR p_selected_candidate_id <> v_ids[1]
    OR v_run.candidate_set_sha256 IS NULL
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  v_preimage := pg_catalog.convert_to('dasher.candidate-ranking.v1', 'UTF8')
    || pg_catalog.decode('00', 'hex')
    || v_run.candidate_set_sha256
    || pg_catalog.int8send(pg_catalog.cardinality(v_ids));
  FOR v_ranked IN
    SELECT candidate.candidate_id, candidate.candidate_spec_sha256,
      candidate.rank,
      CASE verdict.value->>'verdict' WHEN 'preferred' THEN 0 ELSE 1 END
        AS review_ordinal,
      (SELECT pg_catalog.count(*) FROM dasher.claims AS claim
       WHERE claim.organization_id = candidate.organization_id
         AND claim.dashboard_id = candidate.dashboard_id
         AND claim.run_id = candidate.run_id
         AND claim.candidate_id = candidate.candidate_id
         AND claim.evidence_state = 'contradicted') AS contradicted_count,
      (SELECT pg_catalog.count(*) FROM dasher.claims AS claim
       WHERE claim.organization_id = candidate.organization_id
         AND claim.dashboard_id = candidate.dashboard_id
         AND claim.run_id = candidate.run_id
         AND claim.candidate_id = candidate.candidate_id
         AND (claim.evidence_state IN ('partial','stale','unsupported')
           OR claim.label IN ('unknown','blocked'))) AS weak_count,
      (SELECT pg_catalog.count(*) FROM dasher.claims AS claim
       WHERE claim.organization_id = candidate.organization_id
         AND claim.dashboard_id = candidate.dashboard_id
         AND claim.run_id = candidate.run_id
         AND claim.candidate_id = candidate.candidate_id
         AND claim.evidence_state = 'complete'
         AND EXISTS (SELECT 1 FROM dasher.claim_evidence AS edge
           JOIN dasher.candidate_comparison_bundle_evidence AS member
             ON member.organization_id = edge.organization_id
            AND member.dashboard_id = edge.dashboard_id
            AND member.run_id = edge.run_id
            AND member.bundle_id = edge.bundle_id
            AND member.evidence_id = edge.evidence_id
            AND member.freshness = 'current'
           WHERE edge.organization_id = claim.organization_id
             AND edge.dashboard_id = claim.dashboard_id
             AND edge.run_id = claim.run_id
             AND edge.candidate_id = claim.candidate_id
             AND edge.claim_id = claim.claim_id
             AND edge.relation = 'supports')) AS complete_supported_count
    FROM dasher.agent_candidates AS candidate
    JOIN dasher.candidate_evidence_manifests AS manifest
      ON manifest.organization_id = candidate.organization_id
     AND manifest.dashboard_id = candidate.dashboard_id
     AND manifest.run_id = candidate.run_id
     AND manifest.candidate_id = candidate.candidate_id
    JOIN dasher.agent_recorded_results AS reviewer
      ON reviewer.organization_id = manifest.organization_id
     AND reviewer.dashboard_id = manifest.dashboard_id
     AND reviewer.run_id = manifest.run_id
     AND reviewer.result_id = manifest.reviewer_result_id
    CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(
      pg_catalog.convert_from(reviewer.canonical_bytes, 'UTF8')::jsonb
        #>'{result,verdicts}'
    ) AS verdict(value)
    WHERE candidate.organization_id = v_run.organization_id
      AND candidate.dashboard_id = v_run.dashboard_id
      AND candidate.run_id = v_run.run_id
      AND candidate.candidate_id = ANY(v_ids)
      AND verdict.value->>'candidate_id' = candidate.candidate_id::text
    ORDER BY pg_catalog.array_position(v_ids, candidate.candidate_id)
  LOOP
    v_preimage := v_preimage
      || pg_catalog.uuid_send(v_ranked.candidate_id)
      || v_ranked.candidate_spec_sha256
      || pg_catalog.int8send(v_ranked.review_ordinal)
      || pg_catalog.int8send(v_ranked.contradicted_count)
      || pg_catalog.int8send(v_ranked.weak_count)
      || pg_catalog.int8send(v_ranked.complete_supported_count)
      || pg_catalog.int8send(
        pg_catalog.array_position(v_ids, v_ranked.candidate_id)
      );
  END LOOP;
  v_expected := pg_catalog.sha256(
    v_preimage || pg_catalog.uuid_send(p_selected_candidate_id)
  );
  IF v_expected <> p_ranking_proof_sha256 THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  IF v_run.terminal_operation_kind IS NOT NULL THEN
    IF v_run.terminal_operation_kind <> 'ranking'
      OR v_run.terminal_operation_id <> p_terminal_operation_id
      OR v_run.selected_candidate_id <> p_selected_candidate_id
    THEN
      RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
    END IF;
    RETURN ROW(
      ROW(v_run.run_id, v_run.run_revision, v_run.state,
        v_run.current_event_sequence, v_run.current_event_sha256,
        v_run.lease_epoch)::dasher_run_api.run_mutation_result,
      p_selected_candidate_id, v_ids, v_ranks, p_ranking_proof_sha256
    )::dasher_run_api.ranking_result;
  END IF;
  UPDATE dasher.agent_candidates AS candidate
  SET rank = pg_catalog.array_position(v_ids, candidate.candidate_id),
      selected = candidate.candidate_id = p_selected_candidate_id
  WHERE candidate.organization_id = v_run.organization_id
    AND candidate.dashboard_id = v_run.dashboard_id AND candidate.run_id = v_run.run_id
    AND candidate.candidate_id = ANY(v_ids);
  SELECT pg_catalog.array_agg(candidate.candidate_id ORDER BY candidate.rank),
      pg_catalog.array_agg(candidate.rank ORDER BY candidate.rank)
    INTO v_ids, v_ranks
  FROM dasher.agent_candidates AS candidate
  WHERE candidate.organization_id = v_run.organization_id
    AND candidate.dashboard_id = v_run.dashboard_id AND candidate.run_id = v_run.run_id
    AND candidate.rank IS NOT NULL;
  PERFORM pg_catalog.set_config('dasher.run_next_state', 'approval_required', true);
  PERFORM pg_catalog.set_config('dasher.run_clear_lease', 'true', true);
  PERFORM pg_catalog.set_config('dasher.run_selected_candidate_id', p_selected_candidate_id::text, true);
  PERFORM pg_catalog.set_config('dasher.run_terminal_operation_kind', 'ranking', true);
  PERFORM pg_catalog.set_config('dasher.run_terminal_operation_id', p_terminal_operation_id::text, true);
  v_mutation := dasher_private.append_agent_run_event_v1(
    v_run.run_id, dasher_private.uuid_v8_from_sha256_v1(pg_catalog.convert_to(pg_catalog.clock_timestamp()::text || '|' || pg_catalog.txid_current()::text || '|' || pg_catalog.random()::text, 'UTF8')), 'run_ranked',
    pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'ordered_candidate_ids', pg_catalog.to_jsonb(v_ids),
      'ordered_ranks', (
        SELECT pg_catalog.jsonb_agg('i64:' || rank_value::text ORDER BY ordinal)
        FROM pg_catalog.unnest(v_ranks) WITH ORDINALITY
          AS rank_row(rank_value, ordinal)
      ),
      'ranking_sha256', pg_catalog.encode(p_ranking_proof_sha256, 'hex'),
      'selected_candidate_id', p_selected_candidate_id::text,
      'terminal_operation_id', p_terminal_operation_id::text
    )::text, 'UTF8')
  );
  RETURN ROW(v_mutation, p_selected_candidate_id, v_ids, v_ranks,
    p_ranking_proof_sha256)::dasher_run_api.ranking_result;
END
$function$;

CREATE OR REPLACE FUNCTION dasher_run_api.finish_agent_run(
  p_run_id uuid,
  p_lease_epoch bigint,
  p_attempt_token bytea,
  p_terminal_operation_id uuid,
  p_terminal_outcome text,
  p_canonical_reason_bytes bytea
)
RETURNS dasher_run_api.run_mutation_result
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_run dasher.agent_runs%ROWTYPE;
  v_reason_sha bytea;
  v_mutation dasher_run_api.run_mutation_result;
BEGIN
  IF p_terminal_operation_id IS NULL
    OR p_terminal_outcome NOT IN ('rejected', 'cancelled', 'expired', 'failed')
    OR p_canonical_reason_bytes IS NULL
    OR pg_catalog.octet_length(p_canonical_reason_bytes) NOT BETWEEN 1 AND 4096
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  BEGIN
    IF pg_catalog.jsonb_typeof(
      pg_catalog.convert_from(p_canonical_reason_bytes, 'UTF8')::jsonb
    ) <> 'object' THEN
      RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
    END IF;
  EXCEPTION WHEN character_not_in_repertoire OR invalid_text_representation THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END;
  v_reason_sha := pg_catalog.sha256(
    pg_catalog.convert_to('dasher.agent-run-terminal-reason.v1', 'UTF8')
    || pg_catalog.decode('00', 'hex')
    || pg_catalog.int4send(pg_catalog.octet_length(p_canonical_reason_bytes))
    || p_canonical_reason_bytes
  );
  PERFORM dasher_private.initialize_run_operator_context_v1(p_run_id, 'finish');
  PERFORM dasher_private.reauthorize_agent_run_v1(p_run_id, p_lease_epoch, p_attempt_token);
  IF NULLIF(current_setting(
    'dasher.run_replay_source_id', true
  ), '') IS NOT NULL THEN
    PERFORM dasher_private.replay_source_fence_v1(
      NULLIF(current_setting('dasher.run_organization_id', true), '')::uuid,
      NULLIF(current_setting('dasher.run_replay_source_id', true), '')::uuid
    );
    PERFORM pg_catalog.set_config('dasher.run_phase', 'authorized', true);
  END IF;
  SELECT run.* INTO STRICT v_run FROM dasher.agent_runs AS run
  WHERE run.organization_id = current_setting('dasher.run_organization_id', true)::uuid
    AND run.run_id = p_run_id FOR UPDATE;
  IF v_run.terminal_operation_kind IS NOT NULL THEN
    IF v_run.terminal_operation_kind <> 'finish'
      OR v_run.terminal_operation_id <> p_terminal_operation_id
      OR v_run.state <> p_terminal_outcome
      OR v_run.terminal_reason_sha256 <> v_reason_sha
    THEN
      RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
    END IF;
    RETURN ROW(v_run.run_id, v_run.run_revision, v_run.state,
      v_run.current_event_sequence, v_run.current_event_sha256,
      v_run.lease_epoch)::dasher_run_api.run_mutation_result;
  END IF;
  IF EXISTS (
    SELECT 1 FROM dasher.agent_run_attempts AS attempt
    WHERE attempt.organization_id = v_run.organization_id
      AND attempt.dashboard_id = v_run.dashboard_id AND attempt.run_id = v_run.run_id
      AND attempt.state IN ('reserved_pre_dispatch', 'dispatch_ready', 'dispatch_started')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  PERFORM pg_catalog.set_config('dasher.run_next_state', p_terminal_outcome, true);
  PERFORM pg_catalog.set_config('dasher.run_clear_lease', 'true', true);
  PERFORM pg_catalog.set_config('dasher.run_terminal_operation_kind', 'finish', true);
  PERFORM pg_catalog.set_config('dasher.run_terminal_operation_id', p_terminal_operation_id::text, true);
  PERFORM pg_catalog.set_config('dasher.run_terminal_reason_sha256', pg_catalog.encode(v_reason_sha, 'hex'), true);
  v_mutation := dasher_private.append_agent_run_event_v1(
    v_run.run_id, dasher_private.uuid_v8_from_sha256_v1(pg_catalog.convert_to(pg_catalog.clock_timestamp()::text || '|' || pg_catalog.txid_current()::text || '|' || pg_catalog.random()::text, 'UTF8')), 'run_finished',
    pg_catalog.convert_to(pg_catalog.jsonb_build_object(
      'reason_sha256', pg_catalog.encode(v_reason_sha, 'hex'),
      'terminal_operation_id', p_terminal_operation_id::text,
      'terminal_outcome', p_terminal_outcome
    )::text, 'UTF8')
  );
  RETURN v_mutation;
END
$function$;

CREATE OR REPLACE FUNCTION dasher_private.agent_run_transition_guard_v1()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog
AS $function$
DECLARE
  v_event_kind text;
  v_event_id uuid;
  v_event_payload_id uuid;
  v_takeover_settlement boolean := false;
BEGIN
  IF TG_LEVEL <> 'ROW' OR TG_WHEN <> 'BEFORE' OR TG_OP <> 'UPDATE'
    OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.dashboard_id IS DISTINCT FROM OLD.dashboard_id
    OR NEW.run_id IS DISTINCT FROM OLD.run_id
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;

  IF current_user = 'dasher_retention_definer'::name
    AND current_setting('dasher.retention_phase', true) = 'authorized'
    AND OLD.state IN ('rejected', 'cancelled', 'expired', 'failed', 'approval_required')
    AND NEW.state = OLD.state
    AND NEW.run_revision = OLD.run_revision
    AND NEW.current_event_sequence = OLD.current_event_sequence
    AND NEW.current_event_sha256 = OLD.current_event_sha256
  THEN
    IF NEW.request_payload_id IS NULL
      AND NEW.candidate_set_sha256 IS NULL
      AND NEW.terminal_reason_sha256 IS NULL
      AND NEW.selected_candidate_id IS NULL
      AND NEW.consumed_replay_sequence IS NULL
      AND NEW.consumed_replay_sha256 IS NULL
      AND NEW.terminal_claim_input_sha256 IS NULL
      AND NEW.terminal_operation_sha256 IS NULL
      AND pg_catalog.to_jsonb(NEW) - ARRAY[
        'request_payload_id','candidate_set_sha256','terminal_reason_sha256',
        'selected_candidate_id','consumed_replay_sequence',
        'consumed_replay_sha256','terminal_claim_input_sha256',
        'terminal_operation_sha256'
      ] IS NOT DISTINCT FROM pg_catalog.to_jsonb(OLD) - ARRAY[
        'request_payload_id','candidate_set_sha256','terminal_reason_sha256',
        'selected_candidate_id','consumed_replay_sequence',
        'consumed_replay_sha256','terminal_claim_input_sha256',
        'terminal_operation_sha256'
      ]
      AND dasher_private.retention_policy_allows_v1(
        OLD.organization_id, OLD.dashboard_id
      )
    THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;

  IF NEW.state = 'accepted'
    OR OLD.state IN ('rejected', 'cancelled', 'expired', 'failed')
      AND NEW IS DISTINCT FROM OLD
    OR NEW.run_revision <> OLD.run_revision + 1
    OR NEW.current_event_sequence <> OLD.current_event_sequence + 1
    OR NEW.current_event_sha256 IS NOT DISTINCT FROM OLD.current_event_sha256
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;

  IF current_user NOT IN (
    'dasher_security_definer'::name,
    'dasher_run_definer'::name,
    'dasher_retention_definer'::name
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
  END IF;

  IF current_user = 'dasher_run_definer'::name THEN
    IF (
      current_setting('dasher.run_phase', true) <> 'authorized'
      OR current_setting('dasher.run_capability', true) IS NULL
      OR current_setting('dasher.run_principal_id', true) IS NULL
      OR current_setting('dasher.run_principal_revision', true) IS NULL
      OR current_setting('dasher.run_organization_id', true) IS NULL
      OR current_setting('dasher.run_dashboard_id', true) IS NULL
      OR current_setting('dasher.run_id', true) IS NULL
      OR current_setting('dasher.run_policy_revision', true) IS NULL
      OR OLD.organization_id <> current_setting(
        'dasher.run_organization_id', true
      )::uuid
      OR OLD.dashboard_id <> current_setting(
        'dasher.run_dashboard_id', true
      )::uuid
      OR OLD.run_id <> current_setting('dasher.run_id', true)::uuid
      OR OLD.policy_revision <> current_setting(
        'dasher.run_policy_revision', true
      )::bigint
    ) THEN
      RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
    END IF;
  ELSIF current_user = 'dasher_security_definer'::name THEN
    IF (
      current_setting('dasher.security_phase', true) <> 'authorized'
      OR current_setting('dasher.security_capability', true) <> 'cancel_agent_run'
      OR OLD.organization_id <> dasher_private.context_organization_id()
      OR OLD.run_id <> current_setting('dasher.security_run_id', true)::uuid
    ) THEN
      RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
    END IF;
  ELSE
    IF NOT dasher_private.retention_policy_allows_v1(
      OLD.organization_id, OLD.dashboard_id
    ) THEN
      RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'dasher_denied';
    END IF;
  END IF;

  IF NEW.run_request_id IS DISTINCT FROM OLD.run_request_id
    OR NEW.request_payload_id IS DISTINCT FROM OLD.request_payload_id
    OR NEW.requesting_user_id IS DISTINCT FROM OLD.requesting_user_id
    OR NEW.requesting_membership_id IS DISTINCT FROM OLD.requesting_membership_id
    OR NEW.requesting_authority_revision
      IS DISTINCT FROM OLD.requesting_authority_revision
    OR NEW.policy_revision IS DISTINCT FROM OLD.policy_revision
    OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
    OR NEW.lease_epoch < OLD.lease_epoch
    OR NEW.latest_checkpoint_revision < OLD.latest_checkpoint_revision
    OR (OLD.candidate_set_sha256 IS NOT NULL
      AND NEW.candidate_set_sha256 IS DISTINCT FROM OLD.candidate_set_sha256)
    OR (OLD.terminal_operation_kind IS NOT NULL
      AND NEW.terminal_operation_kind IS DISTINCT FROM OLD.terminal_operation_kind)
    OR (OLD.terminal_operation_id IS NOT NULL
      AND NEW.terminal_operation_id IS DISTINCT FROM OLD.terminal_operation_id)
    OR (OLD.tenant_cancel_operation_id IS NOT NULL
      AND ROW(
        NEW.tenant_cancel_operation_id,
        NEW.tenant_cancel_operation_sha256,
        NEW.tenant_cancel_result_sha256,
        NEW.tenant_cancel_result_run_revision,
        NEW.tenant_cancel_result_event_sequence,
        NEW.tenant_cancel_result_event_sha256
      ) IS DISTINCT FROM ROW(
        OLD.tenant_cancel_operation_id,
        OLD.tenant_cancel_operation_sha256,
        OLD.tenant_cancel_result_sha256,
        OLD.tenant_cancel_result_run_revision,
        OLD.tenant_cancel_result_event_sequence,
        OLD.tenant_cancel_result_event_sha256
      ))
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;

  SELECT event.event_kind, event.event_id, event.event_payload_id
    INTO STRICT v_event_kind, v_event_id, v_event_payload_id
  FROM dasher.agent_run_events AS event
  WHERE event.organization_id = NEW.organization_id
    AND event.dashboard_id = NEW.dashboard_id
    AND event.run_id = NEW.run_id
    AND event.event_sequence = NEW.current_event_sequence
    AND event.event_sha256 = NEW.current_event_sha256
    AND event.prior_event_sequence = OLD.current_event_sequence
    AND event.prior_event_sha256 = OLD.current_event_sha256;

  IF v_event_kind = 'attempt_indeterminate' THEN
    v_takeover_settlement := dasher_private.agent_run_takeover_settlement_v1(
      NEW.organization_id,
      NEW.dashboard_id,
      NEW.run_id,
      v_event_payload_id,
      v_event_id,
      NEW.current_event_sequence,
      NEW.run_revision,
      OLD.lease_epoch + 1
    );
  END IF;

  IF (v_event_kind = 'run_cancelled' AND NEW.state <> 'cancelled')
    OR (v_event_kind = 'run_cleanup_cancelled' AND NEW.state <> 'cancelled')
    OR (v_event_kind = 'run_ranked' AND NEW.state <> 'approval_required')
    OR (v_event_kind = 'run_abstained' AND NEW.state <> 'rejected')
    OR (v_event_kind = 'attempt_indeterminate'
      AND NOT v_takeover_settlement AND NEW.state <> 'failed')
    OR (v_event_kind = 'attempt_indeterminate' AND v_takeover_settlement
      AND (
        NEW.state <> OLD.state
        OR NEW.lease_epoch <> OLD.lease_epoch
        OR OLD.state NOT IN (
          'requested','authorized','planning','generating','revising','validating'
        )
      ))
    OR (v_event_kind = 'indeterminate_quarantined' AND NEW.state <> 'failed')
    OR (v_event_kind = 'lease_acquired' AND NOT (
      (OLD.state = 'requested' AND NEW.state = 'authorized')
      OR (OLD.state IN (
        'authorized','planning','generating','revising','validating'
      ) AND NEW.state = OLD.state)
    ))
    OR (v_event_kind = 'run_finished'
      AND NEW.state NOT IN ('rejected','cancelled','expired','failed'))
    OR (v_event_kind = 'attempt_reserved' AND NOT (
      (OLD.state = 'authorized' AND NEW.state = 'planning')
      OR (OLD.state = 'planning' AND NEW.state IN ('planning','generating'))
      OR (OLD.state = 'generating' AND NEW.state IN ('generating','revising'))
      OR (OLD.state IN ('revising','validating') AND NEW.state = OLD.state)
    ))
    OR (v_event_kind = 'replay_prerequisites_cloned' AND NOT (
      OLD.state = 'authorized' AND NEW.state = 'planning'
    ))
    OR (v_event_kind = 'replay_result_consumed' AND NOT (
      OLD.state = 'planning' AND NEW.state IN ('planning','generating')
    ))
    OR (v_event_kind = 'candidate_set_closed' AND NOT (
      OLD.state IN ('generating','revising') AND NEW.state = 'validating'
    ))
    OR (v_event_kind NOT IN (
      'run_cancelled','run_cleanup_cancelled','run_ranked','run_abstained',
      'attempt_indeterminate','indeterminate_quarantined','lease_acquired','run_finished',
      'attempt_reserved','replay_prerequisites_cloned','replay_result_consumed',
      'candidate_set_closed'
    ) AND NEW.state <> OLD.state)
    OR (NEW.state IN ('approval_required','rejected','cancelled','expired','failed')
      AND ROW(
        NEW.lease_token_sha256, NEW.lease_owner_principal_id,
        NEW.lease_owner_principal_revision, NEW.lease_expires_at
      ) IS DISTINCT FROM ROW(NULL::bytea,NULL::uuid,NULL::bigint,NULL::timestamptz))
    OR ((NEW.tenant_cancel_operation_id IS NULL)
      <> (NEW.tenant_cancel_operation_sha256 IS NULL)
      OR (NEW.tenant_cancel_operation_id IS NULL)
      <> (NEW.tenant_cancel_result_sha256 IS NULL)
      OR (NEW.tenant_cancel_operation_id IS NULL)
      <> (NEW.tenant_cancel_result_run_revision IS NULL)
      OR (NEW.tenant_cancel_operation_id IS NULL)
      <> (NEW.tenant_cancel_result_event_sequence IS NULL)
      OR (NEW.tenant_cancel_operation_id IS NULL)
      <> (NEW.tenant_cancel_result_event_sha256 IS NULL))
    OR (NEW.tenant_cancel_operation_id IS NOT NULL AND (
      NEW.state <> 'cancelled'
      OR pg_catalog.octet_length(NEW.tenant_cancel_operation_sha256) <> 32
      OR pg_catalog.octet_length(NEW.tenant_cancel_result_sha256) <> 32
      OR pg_catalog.octet_length(NEW.tenant_cancel_result_event_sha256) <> 32
      OR NEW.tenant_cancel_result_run_revision <> NEW.run_revision
      OR NEW.tenant_cancel_result_event_sequence <> NEW.current_event_sequence
      OR NEW.tenant_cancel_result_event_sha256 <> NEW.current_event_sha256
    ))
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';
  END IF;
  RETURN NEW;
END
$function$;

ALTER FUNCTION dasher_private.calculation_graph_constraint_guard_v1()
  SECURITY DEFINER;
