-- Dasher agent-run cancel attempt-context correction.
--
-- One frozen defect is repaired here, and nothing else in the series is
-- touched. Frozen 0007 defines dasher_api.cancel_agent_run (0007:19760) and
-- migration 0008 re-issues its body (0008:5358-5910) to normalize the audit
-- insert's unique_violation. In both, a fresh tenant cancellation walks every
-- nonterminal attempt of the run in ascending canonical attempt-id byte order
-- (0008:5625-5630), settles each one against the run's budget counters, and
-- appends exactly one per-attempt event through
-- dasher_private.append_agent_run_event_v1 - attempt_cancelled_charged for a
-- 'dispatch_started' attempt (0008:5683) and attempt_cancelled_released for a
-- 'reserved_pre_dispatch'/'dispatch_ready' attempt (0008:5709) - and only after
-- the last per-attempt event appends the single aggregate run_cancelled header
-- that terminalizes the run as 'cancelled' (0008:5876-5888).
--
-- The append helper resolves the run it is appending to solely from two
-- transaction-local settings. It selects dasher.agent_runs FOR UPDATE on
-- dasher.run_organization_id and dasher.run_dashboard_id (0007:8470-8479) and
-- raises P1001 dasher_denied when that select finds no row (0007:8480-8482).
-- current_setting(name, true) returns NULL for a setting that was never
-- installed in the transaction, so both equality predicates are NULL, the row
-- is never found, and the helper denies.
--
-- cancel_agent_run installs both settings at 0008:5869-5870 - after the attempt
-- loop has already closed. Every fresh cancellation of a run that still holds a
-- nonterminal attempt therefore fails inside the first per-attempt append,
-- before any attempt event row exists, and the whole transaction rolls back.
-- Only a run holding no nonterminal attempt can be cancelled at all: its loop
-- body never executes, so the first append the call makes is the aggregate one,
-- by which point 0008:5869-5870 has run. The §4.7 cancel profile requires the
-- opposite - a fresh cancellation settles the run's active attempts and their
-- counters - so the reserved-pre-dispatch release path, the dispatch-started
-- charge path, their released/charged equations, the zeroed outstanding
-- vectors, the counter updates and the charged/released attempt-id arrays the
-- run_cancelled header carries (0008:5881-5884) are all unreachable. Migration
-- 0009 replaces the transition guard and does not touch this routine.
--
-- The repair is an ordering change and nothing else. The routine is re-issued
-- with CREATE OR REPLACE - the same body-correction convention 0004, 0006, 0008
-- and 0009 already use, which preserves the routine's identity, owner
-- dasher_security_definer (0007:24593), its EXECUTE ACL (0007:24604-24616) and
-- its declared volatility, SECURITY DEFINER status and fixed
-- search_path = pg_catalog - and the two set_config calls that install
-- dasher.run_organization_id and dasher.run_dashboard_id move from after the
-- attempt loop to immediately before it. Nothing else in the body moves,
-- changes or is added: the two moved statements are byte-identical to
-- 0008:5869-5870 and every other line is byte-identical to 0008:5358-5910.
--
-- The moved statements install exactly the values they installed before. Both
-- read v_run, which the authorization sequence binds FOR UPDATE at
-- 0008:5517-5522 and which the loop re-reads after each settlement
-- (0008:5726-5731) under a predicate fixed on the same organization, the same
-- dashboard and the same run, so v_run.organization_id and v_run.dashboard_id
-- are invariant across the loop and the post-loop read they were taken from is
-- the same tuple as the pre-loop read they are taken from now.
--
-- The new position is after the budget-counter lock (0008:5617-5624) and before
-- the loop, so it lies on exactly the path that reaches a per-attempt append.
-- The two earlier exits are unchanged: the retained-result replay path returns
-- its stored projection (0008:5546-5608) and the revision/state mismatch raises
-- P1002 dasher_conflict (0008:5609-5616), both without installing either
-- setting, exactly as before.
--
-- One install serves every append in the call. The helper clears each
-- per-append directive setting after it commits its row update - run_next_state,
-- run_clear_lease, the checkpoint, candidate-set, selected-candidate, replay,
-- terminal-reason, terminal-operation and tenant-cancel settings
-- (0007:8844-8858) - but it never clears run_organization_id or
-- run_dashboard_id, which are the run-context settings its own lookup reads.
-- The aggregate append's directives therefore stay exactly where 0008 sets them
-- (0008:5871-5875), immediately before the run_cancelled append that consumes
-- them.
--
-- The per-attempt appends consequently run with no directive installed, which
-- is what the frozen contracts require of them. With run_next_state unset the
-- frozen row update leaves dasher.agent_runs.state as it found it
-- (0007:8718-8723), and the frozen transition guard demands precisely that:
-- attempt_cancelled_released and attempt_cancelled_charged are not among the
-- event kinds licensed to move the run state, so the guard's residual clause
-- requires NEW.state = OLD.state for them (0007:5172-5176). With
-- run_clear_lease unset the lease epoch, token, owner and expiry are left alone
-- (0007:8727-8743), so the single lease fence stays on the aggregate event.
-- With run_tenant_cancel_operation_id unset every tenant-cancel column keeps
-- its prior NULL (0007:8806-8832) and the guard's null-consistency clause
-- (0007:5182-5191) holds; the guard's terminal-immutability, revision and chain
-- clauses (0007:5042-5050) are satisfied because each per-attempt append
-- advances run_revision and the event chain by exactly one from a nonterminal
-- state. The security-phase gate the guard applies to this routine
-- (0007:5083-5091) reads settings installed at 0008:5443-5480, before the loop
-- in both the frozen body and this one, and is unaffected.
--
-- Nothing else is corrected or hardened here. No role, relation, column,
-- constraint, index, policy, trigger or routine identity is added, dropped or
-- renamed; no grant is widened; no dynamic SQL, caller authority or diagnostic
-- detail is introduced; and no later-task behavior is implemented. Replacing a
-- routine body renames no identity and contributes no inventory entry, so the
-- canonical phase-10 entry count equals phase 9's and only the one routine
-- definition the phase fingerprint hashes moves.

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
  PERFORM pg_catalog.set_config('dasher.run_organization_id', v_run.organization_id::text, true);
  PERFORM pg_catalog.set_config('dasher.run_dashboard_id', v_run.dashboard_id::text, true);
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
