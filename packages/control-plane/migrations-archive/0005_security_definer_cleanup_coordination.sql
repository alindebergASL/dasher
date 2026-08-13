-- Dasher security-definer cleanup-coordination authority correction.

GRANT INSERT (
  organization_id,
  dashboard_id,
  current_step,
  expected_lifecycle_revision,
  next_attempt_at
) ON TABLE dasher.dashboard_cleanup_coordination
TO dasher_security_definer;

CREATE POLICY dashboard_cleanup_coordination_security_definer_insert
ON dasher.dashboard_cleanup_coordination
AS PERMISSIVE
FOR INSERT
TO dasher_security_definer
WITH CHECK (
  CURRENT_USER = 'dasher_security_definer'::name
  AND organization_id = dasher_private.context_organization_id()
);
