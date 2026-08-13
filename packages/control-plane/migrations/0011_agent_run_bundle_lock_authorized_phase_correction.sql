-- Dasher agent-run bundle-lock authorized-phase correction.
--
-- One frozen defect is repaired here, and nothing else in the series is
-- touched. Frozen 0007 defines dasher_run_api.commit_agent_brief
-- (0007:12375-12472). The routine installs its operator context through
-- dasher_private.initialize_run_operator_context_v1(p_run_id, 'commit_brief')
-- (0007:12401), which sets dasher.run_capability to that exact capability
-- (0007:7774) and leaves dasher.run_phase at 'discovering' (0007:7776). It then
-- calls dasher_private.reauthorize_agent_run_v1 (0007:12402-12404), which runs
-- its lock pass under dasher.run_phase = 'locking' (0007:7847) and, only after
-- every lock and revalidation in that pass has passed, promotes the phase to
-- 'authorized' (0007:8174) before returning.
--
-- Every statement in the remainder of commit_agent_brief therefore executes at
-- phase 'authorized' with capability 'commit_brief'. One of those statements is
-- the routine's own bundle header lock (0007:12423-12427):
--
--   PERFORM 1 FROM dasher.candidate_comparison_bundles AS bundle
--   WHERE bundle.organization_id = v_run.organization_id
--     AND bundle.dashboard_id = v_run.dashboard_id AND bundle.run_id = v_run.run_id
--     AND bundle.bundle_id = v_bundle_id
--   FOR UPDATE;
--
-- FOR UPDATE is a row mark, so it is filtered by the relation's UPDATE policy.
-- The sole such policy applicable to dasher_run_definer,
-- candidate_comparison_bundles_run_lock_update (0007:7009-7023), admits a row
-- only at dasher.run_phase = 'locking'. At line 12423 the phase is 'authorized',
-- so the predicate is false for every row, the mark selects nothing, FOUND is
-- false, and the immediately following guard (0007:12428-12435) raises
-- P1002 dasher_invalid.
--
-- The denial is unconditional and does not depend on the caller. A fully legal
-- commit of a well-formed Brief, against the correct run, in state 'planning',
-- naming the run's own existing bundle, with a recorded planner_output result
-- present, is rejected exactly as a malformed one is. dasher_run_api.commit_agent_brief
-- is consequently unreachable on every path, and with it every downstream
-- journey that requires a committed Brief. Migrations 0008, 0009 and 0010 do not
-- touch this routine or this policy.
--
-- The repair is one added policy arm and nothing else. The policy is re-issued
-- with ALTER POLICY, which by construction preserves the relation, the policy
-- name, its PERMISSIVE permissiveness, its UPDATE command, its dasher_run_definer
-- role list and its WITH CHECK (false), and changes only the USING expression.
-- The existing 'locking' arm is preserved verbatim, and exactly one alternative
-- is added: dasher.run_phase = 'authorized' together with dasher.run_capability
-- exactly 'commit_brief'. The current-user guard and the organization, dashboard
-- and run equalities are unchanged and continue to apply to both arms.
--
-- The added arm is not a widening beyond the single lock it enables.
-- Constraint candidate_comparison_bundles_uq_01 (0007:1196-1198) makes
-- (organization_id, dashboard_id, run_id) unique, so the three retained
-- equalities already identify at most one row; the omission of bundle_id from
-- the predicate is therefore not wider authority than a four-column key would
-- be. The capability conjunct is read through
-- NULLIF(current_setting('dasher.run_capability', true), ''), the same idiom the
-- frozen series already uses for a capability equality (0007:6135-6136), so an
-- absent, empty or pooled-residue setting yields NULL, the equality is not true,
-- and the arm denies rather than widening or raising a raw 22P02.
--
-- No grant changes. The column-scoped identity-only UPDATE grant this policy
-- operates under, GRANT UPDATE (organization_id, dashboard_id, run_id, bundle_id)
-- ON TABLE dasher.candidate_comparison_bundles TO dasher_run_definer
-- (0007:7368-7369), is untouched, and WITH CHECK (false) continues to reject
-- every actual UPDATE, so the arm confers a row mark and nothing more. No other
-- phase, capability, source branch, role, function, trigger, policy, writable
-- column or behavior is added here. Every further local and source bundle
-- capability and body placement belongs to 0012.

ALTER POLICY candidate_comparison_bundles_run_lock_update
ON dasher.candidate_comparison_bundles
USING (
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
);
