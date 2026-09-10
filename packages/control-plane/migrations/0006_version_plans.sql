-- The plan a version was compiled from.
--
-- Refining a saved dashboard means asking the planner to change the plan that
-- produced it, so the plan has to outlive the request that built it. Until now
-- only the compiled spec was kept: enough to render a dashboard again, not
-- enough to change one, which is why reopening a saved dashboard was read-only.
--
-- WHY A TABLE RATHER THAN A COLUMN ON `dashboard_versions`. A column would have
-- to be written by `finalize_run`, and PostgreSQL cannot add a parameter to an
-- existing function through CREATE OR REPLACE — it would mean dropping and
-- recreating the one function every dashboard write already depends on. This
-- deployment holds real data and `DECISIONS.md` item 6 binds: forward-only, and
-- never a window where the running application's call no longer resolves. A new
-- table and a new function are additive, so nothing already deployed changes
-- behaviour when this migration lands ahead of the code that uses it.
--
-- WHY THE PLAN AND NOT THE FILE. The file is already durable: a version cites
-- its `source_snapshots` row and the foreign key keeps those bytes alive. What
-- was missing is the reading — which column was the amount, which the period,
-- which filters applied — and that is the thing a refinement edits.

CREATE TABLE dasher.version_plans (
  organization_id uuid NOT NULL,
  dashboard_id uuid NOT NULL,
  version_id uuid NOT NULL,
  -- The `TablePlan` the compiler was given, as the planner emitted it. Opaque
  -- to the schema in the same sense the spec bytes are: the shape belongs to
  -- `@dasher/planner`, and a database that understood it would be a second
  -- place that has to change when the plan does.
  plan jsonb NOT NULL,
  -- The plan's own version marker, lifted out so a later reader can tell
  -- whether it still understands a stored plan without parsing one.
  plan_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.transaction_timestamp(),
  CONSTRAINT version_plans_pkey PRIMARY KEY (
    organization_id,
    dashboard_id,
    version_id
  ),
  -- Composite, like every other reference here: a plan cannot attach to a
  -- version belonging to another organization even if it learns its id.
  CONSTRAINT version_plans_version_fkey FOREIGN KEY (
    organization_id,
    dashboard_id,
    version_id
  ) REFERENCES dasher.dashboard_versions (
    organization_id,
    dashboard_id,
    version_id
  ),
  -- An object, not an array or a scalar: a plan is a record with roles on it,
  -- and this is the cheapest place to refuse something that cannot be one.
  CONSTRAINT version_plans_plan_object_check CHECK (
    pg_catalog.jsonb_typeof(plan) = 'object'
  ),
  CONSTRAINT version_plans_plan_version_check CHECK (
    plan_version <> '' AND pg_catalog.length(plan_version) <= 64
  )
);

ALTER TABLE dasher.version_plans ENABLE ROW LEVEL SECURITY;

CREATE POLICY version_plans_read ON dasher.version_plans
  AS PERMISSIVE FOR SELECT TO dasher_app
  USING (dasher_private.context_allows(organization_id, 'viewer'));

CREATE POLICY version_plans_insert ON dasher.version_plans
  AS PERMISSIVE FOR INSERT TO dasher_app
  WITH CHECK (dasher_private.context_allows(organization_id, 'editor'));

-- The version it describes is a record, so its plan is one too. A refinement
-- writes a successor version with its own plan; it never edits this one.
CREATE TRIGGER version_plans_immutable
BEFORE UPDATE OR DELETE ON dasher.version_plans
FOR EACH ROW
EXECUTE FUNCTION dasher_private.reject_immutable_mutation();

-- Read-only to the application, like every other table here: the write goes
-- through `dasher_api` so actor attribution and audit stay properties of the
-- schema rather than conventions a caller may follow.
GRANT SELECT ON dasher.version_plans TO dasher_app;

-- Recording a plan is an attributable act, so it needs a name the audit table
-- will accept. A CHECK cannot be extended in place, so the list is restated in
-- full — which means it must be copied from the migration that last stated it,
-- 0002, and NOT from the baseline. Restating the baseline's list would silently
-- drop `sign_in.requested`, and the next sign-in on a live deployment would
-- fail on a constraint nobody had touched. Adding to this list is the only safe
-- direction: every action already stored is still permitted, so no row becomes
-- invalid and no running code loses a name it writes.
ALTER TABLE dasher.audit_events
  DROP CONSTRAINT audit_events_action_check;
ALTER TABLE dasher.audit_events
  ADD CONSTRAINT audit_events_action_check CHECK (
    action IN (
      'membership.role_changed',
      'membership.revoked',
      'invitation.issued',
      'invitation.revoked',
      'invitation.accepted',
      'invitation.accepted_existing_membership',
      'sign_in.requested',
      'session.issued',
      'session.rotated',
      'session.revoked',
      'source_snapshot.created',
      'evidence_record.created',
      'dashboard.created',
      'dashboard.archived',
      'dashboard.unarchived',
      'dashboard_version.created',
      'dashboard_head.promoted',
      'agent_run.started',
      'agent_run.finished',
      'version_plan.recorded'
    )
  );

/*
 * Attach a plan to a version that was just written.
 *
 * Separate from `finalize_run` rather than folded into it, for the reason at
 * the top of this file. Called in the same transaction, so a version and its
 * plan arrive together or not at all.
 *
 * The version must belong to the acting organization and must exist; row-level
 * security would already prevent writing across a tenant boundary, but this
 * turns a foreign-key violation into the seam's own conflict code, which the
 * repository already knows how to name.
 */
CREATE FUNCTION dasher_api.record_version_plan(
  p_version_id uuid,
  p_plan jsonb,
  p_plan_version text,
  p_request_id uuid,
  p_deployment_revision text
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  actor record;
  version_row dasher.dashboard_versions%ROWTYPE;
BEGIN
  SELECT * INTO actor FROM dasher_api.acting_principal('editor');

  SELECT * INTO version_row
  FROM dasher.dashboard_versions AS candidate
  WHERE candidate.organization_id = actor.organization_id
    AND candidate.version_id = p_version_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'dasher_conflict';
  END IF;

  INSERT INTO dasher.version_plans (
    organization_id, dashboard_id, version_id, plan, plan_version
  )
  VALUES (
    actor.organization_id, version_row.dashboard_id, p_version_id,
    p_plan, p_plan_version
  );

  INSERT INTO dasher.audit_events (
    audit_event_id, organization_id, actor_kind, actor_user_id,
    authority_revision, request_id, action, target_type, target_id,
    outcome, deployment_revision
  )
  VALUES (
    pg_catalog.gen_random_uuid(), actor.organization_id, 'user', actor.user_id,
    1, p_request_id, 'version_plan.recorded', 'dashboard_version',
    p_version_id, 'succeeded', p_deployment_revision
  );
END
$function$;

REVOKE ALL ON FUNCTION
  dasher_api.record_version_plan(uuid, jsonb, text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  dasher_api.record_version_plan(uuid, jsonb, text, uuid, text) TO dasher_app;
