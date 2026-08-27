-- ---------------------------------------------------------------------------
-- Signing out
--
-- `sessions.revoked_at`, `sessions.revocation_reason` and the
-- `session.revoked` audit action were all in the baseline, and nothing could
-- reach any of them: of the thirteen functions in `dasher_api`, none revoked a
-- session. `begin_request` has always refused a revoked one — the enforcement
-- half was complete and the acting half did not exist — so a person on a
-- borrowed laptop had a twelve-hour session and no way to end it.
--
-- The same shape as `claims` and `evidence_records` in the commit before last:
-- a modelled fact with no caller.
-- ---------------------------------------------------------------------------

/*
 * End a session, by presenting it.
 *
 * WHY THIS TAKES A TOKEN RATHER THAN RUNNING UNDER A PRINCIPAL. Signing out is
 * the one authenticated action whose whole purpose is to work when the session
 * is questionable. Requiring `acting_principal` would mean a session that is
 * live enough to hold but not live enough to act — expired between page load
 * and click — could not be ended, which is the moment somebody most wants to
 * end it. Possession of the token is the authorisation, exactly as it is for
 * `begin_request`.
 *
 * WHY IT IS NOT AN ERROR TO REVOKE NOTHING. An already-revoked session and a
 * token that was never issued both return false. Signing out twice is not a
 * failure, and telling a caller which case it was would answer "is this a real
 * token?" for anyone holding a stolen one.
 *
 * AN EXPIRED SESSION IS STILL REVOKED, and returns true. The UPDATE filters on
 * the digest and `revoked_at IS NULL` only — deliberately, because that is the
 * same reason this function takes a token rather than a principal: a session
 * that lapsed between page load and click is exactly the one somebody is
 * trying to end, and refusing would leave a row that `begin_request` already
 * rejects but nothing ever marked. The caller must not read the boolean as
 * "the session was live".
 */
CREATE FUNCTION dasher_api.revoke_session(
  p_token_key_version smallint,
  p_token_digest bytea,
  p_reason text,
  p_request_id uuid,
  p_deployment_revision text
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  revoked dasher.sessions%ROWTYPE;
BEGIN
  UPDATE dasher.sessions AS live
  SET revoked_at = pg_catalog.clock_timestamp(),
      revocation_reason = p_reason
  WHERE live.token_key_version = p_token_key_version
    AND live.token_digest = p_token_digest
    AND live.revoked_at IS NULL
  RETURNING * INTO revoked;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  INSERT INTO dasher.audit_events (
    audit_event_id, organization_id, actor_kind, actor_user_id,
    authority_revision, request_id, action, target_type, target_id,
    outcome, content_sha256, deployment_revision
  )
  VALUES (
    pg_catalog.gen_random_uuid(), revoked.organization_id, 'user',
    revoked.user_id, revoked.authority_revision, p_request_id,
    'session.revoked', 'session', revoked.session_id, 'succeeded', NULL,
    p_deployment_revision
  );

  RETURN true;
END
$function$;

GRANT EXECUTE ON FUNCTION
  dasher_api.revoke_session(smallint, bytea, text, uuid, text) TO dasher_app;

-- ---------------------------------------------------------------------------
-- Closing an enumeration oracle the application never needed
--
-- `resolve_external_identity(issuer, subject) -> user_id` answers "does this
-- address have an account here" in one call, and was granted to `dasher_app`
-- from the baseline. Nothing has ever called it.
--
-- That grant contradicts the guarantee `begin_sign_in` was written to provide.
-- Sign-in returns one uniform NULL for an unknown address, a revoked
-- membership, a malformed address and a rate-limited request, precisely so that
-- submitting an address cannot be used to ask whether it is known — and a
-- granted function that answers the same question directly makes that a
-- property of one code path rather than of the application role.
--
-- Revoked rather than dropped: the function is a reasonable thing for a future
-- account-linking flow to use, under a principal. What it should not be is
-- reachable, unauthenticated, by the role that serves public pages.
-- ---------------------------------------------------------------------------

REVOKE EXECUTE ON FUNCTION
  dasher_api.resolve_external_identity(text, text) FROM dasher_app;
