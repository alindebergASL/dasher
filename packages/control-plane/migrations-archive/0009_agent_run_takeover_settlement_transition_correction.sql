-- Dasher agent-run takeover settlement transition correction.
--
-- One frozen defect is repaired here, and nothing else in the series is
-- touched. Frozen 0007 defines a mixed lease takeover in
-- dasher_run_api.claim_agent_run (0007:10521-10748): under one transaction the
-- claim walks every prior-epoch nonterminal attempt in ascending canonical
-- attempt-id byte order, releases each 'reserved_pre_dispatch'/'dispatch_ready'
-- attempt with one attempt_released(release_mode=takeover) event, quarantines
-- each 'dispatch_started' attempt with one
-- attempt_indeterminate(reason_code=takeover_after_dispatch) event, and only
-- after the last per-attempt event appends the single aggregate
-- indeterminate_quarantined header that terminalizes the run as 'failed'
-- (0007:11063-11107).
--
-- Every one of those per-attempt events is appended through
-- dasher_private.append_agent_run_event_v1 without setting
-- 'dasher.run_next_state' (0007:10589, 0007:10679), so the row update each one
-- performs leaves dasher.agent_runs.state exactly as it found it
-- (0007:8723). The frozen transition guard nevertheless requires every
-- attempt_indeterminate event to land the run in 'failed'
-- (0007:5150), and its terminal-immutability clause then rejects any further
-- update once the run is 'failed' (0007:5042-5044). Those three rules cannot
-- hold together: the first quarantined attempt in a mixed walk is rejected with
-- P1002 before the aggregate is ever reached, so a mixed takeover can never
-- commit, and the claim's own settlement/aggregate/terminal-operation digest
-- chain is unreachable. Migration 0008 does not replace either routine.
--
-- The repair is narrow and additive. The guard is re-issued with
-- CREATE OR REPLACE - the same body-correction convention 0004, 0006 and 0008
-- already use - and exactly one of its clauses changes: an attempt_indeterminate
-- event whose own retained payload body carries
-- reason_code = 'takeover_after_dispatch' must now preserve OLD.state instead of
-- forcing 'failed', and may only do so from one of the six dispatch-capable
-- states the claim itself discovers (0007:10374-10376). The other three closed
-- reason codes - caller_indeterminate, malformed_accounting and
-- actual_over_reservation - still require NEW.state = 'failed' in the same
-- event update, the aggregate indeterminate_quarantined header still requires
-- 'failed' on its own, and the terminal-immutability, revision, chain,
-- role/phase, lease-clearing and tenant-cancel clauses are unchanged.
--
-- The branch is decided from the actual retained event payload for the event
-- the update is committing, never from a caller GUC, current_user or run phase.
-- The decision reads dasher.agent_run_event_payloads for the exact
-- (organization, dashboard, run, event_payload_id, event_id, event_sequence)
-- tuple the guard's own frozen chained-event lookup already bound to
-- NEW.current_event_sha256 and to OLD's chain head, and admits the takeover
-- branch only when every one of the following holds. Each is a fact frozen 0007
-- itself writes on this exact path, so nothing here is caller-invented
-- structural JSON.
--
--   1. The retained bytes are 1..1114112 octets and rehash, under the frozen
--      0007 envelope construction (0007:8636-8653), to the row's own stored
--      payload_sha256 over the row's own content_nonce. Substituted content
--      therefore fails even for a role holding INSERT and DELETE on the
--      relation.
--   2. They decode as UTF-8 JSON under the same 22021/22P02 catch registry
--      frozen 0007 uses for the same bytes (0007:8485-8490), and the envelope
--      carries exactly the eleven keys append_agent_run_event_v1 emits
--      (0007:8614-8635) with the exact schema, event kind, event id, run id,
--      'i64:'-tagged event sequence and run revision the guard is committing.
--   3. actor_kind is 'run_operator' and actor_id / actor_revision equal the
--      run-operator principal identity and revision the claim's own context
--      pinned (0007:8601-8606), so a tenant-cancel or retention-authored
--      attempt_indeterminate can never arm the branch.
--   4. The body carries exactly the five keys frozen 0007 fixes for
--      attempt_indeterminate (0007:8517-8519), reason_code
--      'takeover_after_dispatch', the exact prior-epoch-plus-one fence, and an
--      attempt_id that is a syntactically valid lowercase UUID.
--   5. The event id is the deterministic identity the mixed takeover walk
--      derives for this attempt and this prior epoch (0007:10591-10596). That
--      single equality binds the event to one attempt, one epoch and the one
--      production site that constructs it.
--   6. The named attempt row exists under the same organization, dashboard and
--      run; sits in 'indeterminate_quarantined'; carries the prior lease epoch;
--      has a non-null dispatch_started_at - the only surviving evidence of the
--      eligible 'dispatch_started' pre-state, which the walk overwrites before
--      it appends (0007:10561-10588) - a non-null reconciled_at, a null
--      actual_vector, a zero outstanding_vector, and terminal_reason_sha256
--      equal to sha256('takeover_after_dispatch').
--   7. Both settlement vectors are objects carrying exactly the fourteen
--      attempt_resource_vector components, every value matching the
--      'i64:' non-negative integer grammar frozen 0007 tags them with
--      (0007:8582-8587), and both equal the tagged rendering of that attempt
--      row's own used_vector and released_vector.
--   8. Those columns conserve the reservation exactly as the walk writes them
--      (0007:10561-10581): reserved = used + released componentwise; the
--      candidate component is entirely released and never used; every
--      non-candidate component is entirely used and never released; and no
--      component of any vector is negative.
--
-- A missing payload - the governed post-purge tombstone state - a payload that
-- fails any binding, or any error at all leaves the branch off, so the guard
-- falls back to the frozen NEW.state = 'failed' requirement and stays
-- fail-closed. The reader raises nothing of its own: the trailing handler
-- returns false, the same fail-closed convention frozen 0007 already uses for
-- dasher_private.validate_agent_run_policy_chain_v1 (0007:7585-7586), so no
-- parser, privilege or SQL detail can escape through the guard.
--
-- That read cannot happen inside the guard itself. The guard is an
-- invoker-rights trigger, so it executes as whichever managed role drove the
-- update, and frozen 0007 grants dasher.agent_run_event_payloads only INSERT to
-- dasher_security_definer and dasher_run_definer plus INSERT/DELETE to
-- dasher_retention_definer (0007:7240-7243). dasher_run_definer's column SELECT
-- grant (0007:7357-7360) is admitted by exactly one policy,
-- agent_run_event_payloads_run_definer_select (0007:6987), which requires
-- dasher.run_phase = 'checkpoint_replay'; the takeover walk runs under
-- 'authorized'. A guard that read the relation directly would therefore raise
-- 'permission denied for table agent_run_event_payloads' on every tenant
-- cancel_agent_run - which is SECURITY DEFINER owned by dasher_security_definer
-- - and on every retention drain, and would silently read NULL under the run
-- definer, never arming the branch this migration exists for.
--
-- So the read is done by one new SECURITY DEFINER reader,
-- dasher_private.agent_run_takeover_settlement_v1, owned by
-- dasher_security_definer - the single managed role the role bootstrap creates
-- with BYPASSRLS - exactly as frozen 0007 already scopes
-- dasher_private.security_policy_allows_v1 (0007:24479). The reader takes the
-- fully bound tuple and returns one boolean; it is the only object granted
-- SELECT on the payload relation, column-scoped to the same nine columns frozen
-- 0007 already grants dasher_run_definer (0007:7357-7360), and no role gains
-- any table read. Its attempt-row read and its uuid_v8_from_sha256_v1 call need
-- no new authority at all: frozen 0007 already grants dasher_security_definer
-- SELECT on dasher.agent_run_attempts (0007:7262) and EXECUTE on the identity
-- helper (0007:298). EXECUTE on the reader is revoked from PUBLIC and from all
-- three operator/app roles and granted only to dasher_run_definer and
-- dasher_retention_definer, the two non-owner roles whose updates reach the
-- clause.
--
-- The guard's own chained-event lookup returns to the frozen 0007 statement
-- shape - one SELECT ... INTO STRICT over dasher.agent_run_events alone,
-- reading the event payload identity it already stores - so the frozen contract
-- of exactly one matching chained event or a raised exception is preserved
-- unchanged and the guard's privilege footprint is identical to frozen 0007's.
-- The admitted branch additionally requires NEW.lease_epoch = OLD.lease_epoch,
-- which is what every settlement in the walk actually does: none of them sets
-- 'dasher.run_clear_lease', so the frozen row update leaves the epoch alone
-- (0007:8727-8731).
--
-- No relation, column, constraint, index, policy, role or trigger identity is
-- added, dropped or renamed, and no frozen routine identity is either.
-- Replacing a routine body renames no identity; the canonical catalog inventory
-- gains exactly the one new reader and its own grants.

CREATE FUNCTION dasher_private.agent_run_takeover_settlement_v1(
  p_organization_id uuid,
  p_dashboard_id uuid,
  p_run_id uuid,
  p_event_payload_id uuid,
  p_event_id uuid,
  p_event_sequence bigint,
  p_run_revision bigint,
  p_fenced_lease_epoch bigint
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_vector_keys CONSTANT text[] := ARRAY[
    'cache_read_tokens','cache_write_tokens','calls','candidates',
    'cost_micros','input_tokens','output_tokens','reasoning_tokens',
    'repair_attempts','reviewer_attempts','specialist_attempts',
    'total_tokens','wall_millis','work_millis'
  ];
  v_canonical_bytes bytea;
  v_content_nonce bytea;
  v_payload_sha256 bytea;
  v_attempt dasher.agent_run_attempts%ROWTYPE;
  v_retained jsonb;
  v_body jsonb;
  v_attempt_id uuid;
  v_prior_epoch bigint;
  v_used jsonb;
  v_released jsonb;
  v_reserved jsonb;
  v_outstanding jsonb;
  v_key text;
BEGIN
  v_prior_epoch := p_fenced_lease_epoch - 1;

  -- Only the nine columns this migration grants are read: a whole-row read
  -- would need SELECT on created_at as well, which nothing grants.
  SELECT payload.canonical_bytes, payload.content_nonce, payload.payload_sha256
    INTO v_canonical_bytes, v_content_nonce, v_payload_sha256
  FROM dasher.agent_run_event_payloads AS payload
  WHERE payload.organization_id = p_organization_id
    AND payload.dashboard_id = p_dashboard_id
    AND payload.run_id = p_run_id
    AND payload.event_payload_id = p_event_payload_id
    AND payload.event_id = p_event_id
    AND payload.event_sequence = p_event_sequence;

  IF NOT FOUND
    OR pg_catalog.octet_length(v_canonical_bytes)
      NOT BETWEEN 1 AND 1114112
    OR v_payload_sha256 IS DISTINCT FROM pg_catalog.sha256(
      pg_catalog.convert_to('dasher.retained-payload-envelope.v1', 'UTF8')
      || pg_catalog.decode('00', 'hex')
      || pg_catalog.int4send(
        pg_catalog.octet_length('agent-run-event-payload-v1')
      )
      || pg_catalog.convert_to('agent-run-event-payload-v1', 'UTF8')
      || pg_catalog.int4send(
        pg_catalog.octet_length(v_content_nonce)
      )
      || v_content_nonce
      || pg_catalog.int4send(32)
      || pg_catalog.sha256(
        pg_catalog.convert_to('dasher.agent-run-event-payload.v1', 'UTF8')
        || pg_catalog.decode('00', 'hex')
        || pg_catalog.int4send(
          pg_catalog.octet_length(v_canonical_bytes)
        )
        || v_canonical_bytes
      )
    )
  THEN
    RETURN false;
  END IF;

  BEGIN
    v_retained := pg_catalog.convert_from(
      v_canonical_bytes, 'UTF8'
    )::jsonb;
  EXCEPTION
    WHEN SQLSTATE '22021' OR SQLSTATE '22P02' THEN
      RETURN false;
  END;

  IF pg_catalog.jsonb_typeof(v_retained) <> 'object'
    OR (SELECT pg_catalog.array_agg(key_name ORDER BY key_name)
        FROM pg_catalog.jsonb_object_keys(v_retained) AS key_name)
      IS DISTINCT FROM ARRAY[
        'actor_id','actor_kind','actor_revision','body','event_id',
        'event_kind','event_sequence','occurred_at','run_id','run_revision',
        'schema'
      ]::text[]
    OR pg_catalog.jsonb_typeof(v_retained->'occurred_at') <> 'string'
    OR v_retained->>'schema' <> 'agent-run-event-payload-v1'
    OR v_retained->>'event_kind' <> 'attempt_indeterminate'
    OR v_retained->>'event_id' <> p_event_id::text
    OR v_retained->>'run_id' <> p_run_id::text
    OR v_retained->>'event_sequence' <> 'i64:' || p_event_sequence::text
    OR v_retained->>'run_revision' <> 'i64:' || p_run_revision::text
    OR v_retained->>'actor_kind' <> 'run_operator'
    OR v_retained->>'actor_id' IS DISTINCT FROM current_setting(
      'dasher.run_principal_id', true
    )
    OR v_retained->>'actor_revision' IS DISTINCT FROM 'i64:' || current_setting(
      'dasher.run_principal_revision', true
    )
    OR pg_catalog.jsonb_typeof(v_retained->'body') <> 'object'
  THEN
    RETURN false;
  END IF;

  v_body := v_retained->'body';
  IF (SELECT pg_catalog.array_agg(key_name ORDER BY key_name)
      FROM pg_catalog.jsonb_object_keys(v_body) AS key_name)
      IS DISTINCT FROM ARRAY[
        'attempt_id','fenced_lease_epoch','reason_code','released_vector',
        'used_vector'
      ]::text[]
    OR v_body->>'reason_code' <> 'takeover_after_dispatch'
    OR v_body->>'fenced_lease_epoch' <> 'i64:' || p_fenced_lease_epoch::text
    OR pg_catalog.jsonb_typeof(v_body->'attempt_id') <> 'string'
    OR v_body->>'attempt_id' !~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  THEN
    RETURN false;
  END IF;

  v_attempt_id := (v_body->>'attempt_id')::uuid;
  IF p_event_id <> dasher_private.uuid_v8_from_sha256_v1(pg_catalog.sha256(
      pg_catalog.convert_to(
        'dasher.takeover-indeterminate-event-id.v1', 'UTF8'
      ) || pg_catalog.uuid_send(v_attempt_id)
      || pg_catalog.int8send(v_prior_epoch)
    ))
  THEN
    RETURN false;
  END IF;

  SELECT attempt.* INTO v_attempt
  FROM dasher.agent_run_attempts AS attempt
  WHERE attempt.organization_id = p_organization_id
    AND attempt.dashboard_id = p_dashboard_id
    AND attempt.run_id = p_run_id
    AND attempt.attempt_id = v_attempt_id;

  IF NOT FOUND
    OR v_attempt.state <> 'indeterminate_quarantined'
    OR v_attempt.lease_epoch <> v_prior_epoch
    OR v_attempt.dispatch_started_at IS NULL
    OR v_attempt.reconciled_at IS NULL
    OR v_attempt.actual_vector IS NOT NULL
    OR v_attempt.terminal_reason_sha256 IS DISTINCT FROM pg_catalog.sha256(
      pg_catalog.convert_to('takeover_after_dispatch', 'UTF8')
    )
  THEN
    RETURN false;
  END IF;

  v_reserved := pg_catalog.to_jsonb(v_attempt.reserved_vector);
  v_used := pg_catalog.to_jsonb(v_attempt.used_vector);
  v_released := pg_catalog.to_jsonb(v_attempt.released_vector);
  v_outstanding := pg_catalog.to_jsonb(v_attempt.outstanding_vector);

  FOREACH v_key IN ARRAY v_vector_keys LOOP
    IF (v_reserved->>v_key)::numeric < 0
      OR (v_used->>v_key)::numeric < 0
      OR (v_released->>v_key)::numeric < 0
      OR (v_outstanding->>v_key)::numeric <> 0
      OR (v_used->>v_key)::numeric + (v_released->>v_key)::numeric
        <> (v_reserved->>v_key)::numeric
      OR (v_key = 'candidates' AND (
        (v_used->>v_key)::numeric <> 0
        OR (v_released->>v_key)::numeric <> (v_reserved->>v_key)::numeric
      ))
      OR (v_key <> 'candidates' AND (
        (v_released->>v_key)::numeric <> 0
        OR (v_used->>v_key)::numeric <> (v_reserved->>v_key)::numeric
      ))
    THEN
      RETURN false;
    END IF;
  END LOOP;

  IF (SELECT pg_catalog.array_agg(key_name ORDER BY key_name)
      FROM pg_catalog.jsonb_object_keys(v_body->'used_vector') AS key_name)
      IS DISTINCT FROM v_vector_keys
    OR (SELECT pg_catalog.array_agg(key_name ORDER BY key_name)
        FROM pg_catalog.jsonb_object_keys(
          v_body->'released_vector'
        ) AS key_name)
      IS DISTINCT FROM v_vector_keys
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.unnest(ARRAY['used_vector','released_vector']) AS
        vector_key(name)
      CROSS JOIN LATERAL pg_catalog.jsonb_each(
        v_body->vector_key.name
      ) AS component(key, value)
      WHERE pg_catalog.jsonb_typeof(component.value) <> 'string'
        OR (v_body->vector_key.name)->>component.key
          !~ '^i64:(0|[1-9][0-9]*)$'
    )
    OR v_body->'used_vector' IS DISTINCT FROM (
      SELECT pg_catalog.jsonb_object_agg(
        component.key, 'i64:' || component.value
      )
      FROM pg_catalog.jsonb_each_text(v_used) AS component
    )
    OR v_body->'released_vector' IS DISTINCT FROM (
      SELECT pg_catalog.jsonb_object_agg(
        component.key, 'i64:' || component.value
      )
      FROM pg_catalog.jsonb_each_text(v_released) AS component
    )
  THEN
    RETURN false;
  END IF;

  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END
$function$;

ALTER FUNCTION dasher_private.agent_run_takeover_settlement_v1(
  uuid, uuid, uuid, uuid, uuid, bigint, bigint, bigint
) OWNER TO dasher_security_definer;

REVOKE ALL ON FUNCTION dasher_private.agent_run_takeover_settlement_v1(
  uuid, uuid, uuid, uuid, uuid, bigint, bigint, bigint
) FROM PUBLIC, dasher_app, dasher_run_operator, dasher_retention_operator;

GRANT EXECUTE ON FUNCTION dasher_private.agent_run_takeover_settlement_v1(
  uuid, uuid, uuid, uuid, uuid, bigint, bigint, bigint
) TO dasher_run_definer, dasher_retention_definer;

GRANT SELECT (
  organization_id, dashboard_id, run_id, event_payload_id, event_id,
  event_sequence, content_nonce, canonical_bytes, payload_sha256
) ON TABLE dasher.agent_run_event_payloads TO dasher_security_definer;

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
    OR (v_event_kind = 'candidate_set_closed' AND NOT (
      OLD.state IN ('generating','revising') AND NEW.state = 'validating'
    ))
    OR (v_event_kind NOT IN (
      'run_cancelled','run_cleanup_cancelled','run_ranked','run_abstained',
      'attempt_indeterminate','indeterminate_quarantined','lease_acquired','run_finished',
      'attempt_reserved','replay_prerequisites_cloned','candidate_set_closed'
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
