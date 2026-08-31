-- Make the sign-in rate limit atomic per address.
--
-- WHAT WAS WRONG. `begin_sign_in` counted this hour's challenges, compared the
-- count to the limit, and then inserted. Under READ COMMITTED those three steps
-- are not one decision: concurrent transactions each take their snapshot before
-- any of them has inserted, so every one of them reads a count below the limit
-- and every one of them proceeds. A burst of six simultaneous requests for one
-- address stored six challenges against a documented cap of five; a wider burst
-- stored eight. Nothing in the schema prevented it -- `sign_in_challenges` has
-- no constraint that could, because the limit is a rate and not a uniqueness.
--
-- WHY IT MATTERS MORE NOW THAN IT DID. The limit is the only thing standing
-- between a known pilot address and unbounded mail: each challenge sends an
-- email and writes two rows. Until now the sign-in form sat behind the
-- preview's HTTP Basic Auth, so reaching it at all took a shared password. The
-- deployment this migration is part of removes that, which turns a defect
-- nobody could trigger into an endpoint anybody can.
--
-- THE FIX. Take a transaction-scoped advisory lock keyed on the address before
-- counting. Requests for the same address serialize on it; the one holding the
-- lock counts, decides, inserts and commits, and the next one then counts a
-- number that includes that insert. Requests for DIFFERENT addresses take
-- different keys and do not wait on each other, so this does not serialize
-- sign-in globally.
--
-- WHY AN ADVISORY LOCK RATHER THAN A STRICTER ISOLATION LEVEL. SERIALIZABLE
-- would also close it, but by aborting one of the transactions with a
-- serialization failure that every caller would then have to retry -- and the
-- caller here is an unauthenticated endpoint whose whole design is to return
-- the same answer for every outcome. An advisory lock makes the second request
-- wait rather than fail, so the refusal it eventually gets is the ordinary
-- "too many this hour" NULL and is indistinguishable from the others.
--
-- The lock is released at COMMIT or ROLLBACK by PostgreSQL, not by this
-- function. There is no path here that can leak one.

/*
 * A fixed namespace for the first key, so these locks cannot collide with an
 * advisory lock taken anywhere else for an unrelated purpose. The value is
 * arbitrary and only has to stay stable.
 */
CREATE FUNCTION dasher_private.sign_in_lock_namespace()
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $function$ SELECT 1867523641 $function$;

REVOKE ALL ON FUNCTION dasher_private.sign_in_lock_namespace() FROM PUBLIC;

/*
 * Create a challenge for an address, if that address may sign in at all.
 *
 * RETURNS NULL for every reason a link is not being sent: no such identity, no
 * active membership, too many requests this hour. The caller cannot tell them
 * apart, and must not -- the sign-in form says the same sentence either way, so
 * that submitting an address is not a way to ask whether it has an account
 * here. Returning distinct codes would put an enumeration oracle on an
 * unauthenticated endpoint.
 *
 * The token itself is never seen here. The caller generates it, sends it, and
 * passes only its SHA-256, exactly as invitations and sessions work.
 */
CREATE OR REPLACE FUNCTION dasher_api.begin_sign_in(
  p_normalized_email text,
  p_token_key_version smallint,
  p_token_digest bytea,
  p_expires_at timestamptz,
  p_request_id uuid,
  p_deployment_revision text
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  found_user uuid;
  found_org uuid;
  found_revision bigint;
  recent integer;
  new_challenge uuid := pg_catalog.gen_random_uuid();
BEGIN
  -- The oldest active membership, deterministically. A user in two
  -- organizations is not a state this pilot creates, and picking by age rather
  -- than by whatever the planner returns means the same address signs in to the
  -- same organization on every attempt instead of alternating.
  SELECT identity.user_id, member.organization_id, member.authority_revision
  INTO found_user, found_org, found_revision
  FROM dasher.external_identities AS identity
  JOIN dasher.memberships AS member
    ON member.user_id = identity.user_id
   AND member.state = 'active'
  WHERE identity.issuer = dasher_private.email_link_issuer()
    AND identity.subject = p_normalized_email
  ORDER BY member.created_at, member.organization_id
  LIMIT 1;

  IF found_user IS NULL THEN
    RETURN NULL;
  END IF;

  -- Everything from here to COMMIT is one decision for this address.
  --
  -- Taken AFTER the identity lookup on purpose: an address with no account
  -- never reaches this line, so spraying unknown addresses cannot make
  -- anybody wait. `hashtext` can collide, and two colliding addresses would
  -- briefly serialize against each other -- which costs a moment and changes
  -- no answer, whereas a missed lock costs the limit itself.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    dasher_private.sign_in_lock_namespace(),
    pg_catalog.hashtext(p_normalized_email)
  );

  SELECT pg_catalog.count(*) INTO recent
  FROM dasher.sign_in_challenges AS challenge
  WHERE challenge.normalized_email = p_normalized_email
    AND challenge.created_at > pg_catalog.clock_timestamp()
        - pg_catalog.make_interval(hours => 1);

  IF recent >= dasher_private.sign_in_hourly_limit() THEN
    RETURN NULL;
  END IF;

  INSERT INTO dasher.sign_in_challenges (
    challenge_id, organization_id, user_id, normalized_email,
    token_key_version, token_digest, expires_at
  )
  VALUES (
    new_challenge, found_org, found_user, p_normalized_email,
    p_token_key_version, p_token_digest, p_expires_at
  );

  INSERT INTO dasher.audit_events (
    audit_event_id, organization_id, actor_kind, actor_user_id,
    authority_revision, request_id, action, target_type, target_id,
    outcome, content_sha256, deployment_revision
  )
  VALUES (
    pg_catalog.gen_random_uuid(), found_org, 'user', found_user,
    found_revision, p_request_id, 'sign_in.requested', 'sign_in_challenge',
    new_challenge, 'succeeded', NULL, p_deployment_revision
  );

  RETURN new_challenge;
END
$function$;
