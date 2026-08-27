-- ---------------------------------------------------------------------------
-- Passwordless sign-in
--
-- ADR-004 names the built-in path: passwordless, with email magic links as the
-- default, and external IdPs as optional additions rather than replacements.
-- This is that path.
--
-- WHY THE EMAIL IS AN EXTERNAL IDENTITY RATHER THAN A COLUMN ON `users`.
-- ADR-004: "Email is a delivery and invitation/account binding, not a principal
-- identifier. No email match automatically links a built-in credential, Google
-- identity, Microsoft identity, model-provider account, or source connection."
-- A `users.email` column would be exactly the global identifier that rule
-- forbids — every issuer would match on it by construction. Instead the
-- built-in credential is one issuer among the eventual several, and its subject
-- happens to be an email address. Linking a second issuer to the same user
-- stays a separate, deliberate operation rather than a consequence of two
-- providers reporting the same string.
--
-- WHY SIGN-IN IS INVITATION-ONLY. A challenge is only ever created for an
-- address that already has an active membership. There is no path here that
-- creates a user, an organization, or a membership: an unknown address produces
-- no row and no email, and the caller cannot tell that apart from a known one.
-- The alternative — an unknown address provisioning itself an organization —
-- would mean anyone who found the hostname of a pilot deployment could start
-- uploading files to it.
-- ---------------------------------------------------------------------------

-- The issuer that owns the built-in passwordless credential. A constant rather
-- than a literal at each call site, because `external_identities` is keyed on
-- (issuer, subject) and two spellings of this string would be two accounts.
CREATE FUNCTION dasher_private.email_link_issuer()
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $function$ SELECT 'urn:dasher:email-link'::text $function$;

CREATE TABLE dasher.sign_in_challenges (
  challenge_id uuid CONSTRAINT sign_in_challenges_pkey PRIMARY KEY,
  organization_id uuid NOT NULL,
  user_id uuid NOT NULL,
  -- Recorded as it was resolved, so a challenge stays readable after the
  -- identity is relinked. It is not what the challenge is redeemed BY — the
  -- token digest is — and nothing matches on this column at redemption.
  normalized_email varchar(320) NOT NULL,
  token_key_version smallint NOT NULL,
  token_digest bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.transaction_timestamp(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  consumed_session_id uuid,
  CONSTRAINT sign_in_challenges_token_key
    UNIQUE (token_key_version, token_digest),
  CONSTRAINT sign_in_challenges_membership_fkey
    FOREIGN KEY (organization_id, user_id)
    REFERENCES dasher.memberships (organization_id, user_id),
  CONSTRAINT sign_in_challenges_session_fkey
    FOREIGN KEY (organization_id, consumed_session_id)
    REFERENCES dasher.sessions (organization_id, session_id),
  CONSTRAINT sign_in_challenges_email_check CHECK (
    normalized_email = pg_catalog.btrim(normalized_email)
    AND normalized_email = pg_catalog.lower(normalized_email)
    AND pg_catalog.char_length(normalized_email) BETWEEN 1 AND 320
    AND normalized_email !~ '[[:cntrl:]]'
  ),
  CONSTRAINT sign_in_challenges_token_key_version_check CHECK (
    token_key_version BETWEEN 1 AND 32767
  ),
  -- The same 32-byte rule sessions and invitations carry. A digest of another
  -- length is a different hash function, which is a bug rather than a variant.
  CONSTRAINT sign_in_challenges_token_digest_check CHECK (
    pg_catalog.octet_length(token_digest) = 32
  ),
  CONSTRAINT sign_in_challenges_expiry_check CHECK (expires_at > created_at),
  CONSTRAINT sign_in_challenges_consumed_fields_check CHECK (
    (consumed_at IS NULL) = (consumed_session_id IS NULL)
  ),
  CONSTRAINT sign_in_challenges_consumed_window_check CHECK (
    consumed_at IS NULL
    OR (consumed_at >= created_at AND consumed_at < expires_at)
  )
);

-- The rate-limit read: challenges for one address, newest first.
CREATE INDEX sign_in_challenges_email_created_idx
  ON dasher.sign_in_challenges USING btree (normalized_email, created_at DESC);
CREATE INDEX sign_in_challenges_membership_idx
  ON dasher.sign_in_challenges USING btree (organization_id, user_id);
CREATE INDEX sign_in_challenges_session_idx
  ON dasher.sign_in_challenges USING btree (
    organization_id,
    consumed_session_id
  );

-- A challenge may be consumed once and is otherwise immutable. Without this,
-- `consumed_at` could be cleared and a link replayed for as long as it had not
-- expired — the single-use property would be a convention in one function
-- rather than a property of the table.
CREATE FUNCTION dasher_private.guard_sign_in_challenge_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'dasher_immutable';
  END IF;

  IF OLD.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'dasher_immutable';
  END IF;

  IF NEW.challenge_id <> OLD.challenge_id
    OR NEW.organization_id <> OLD.organization_id
    OR NEW.user_id <> OLD.user_id
    OR NEW.normalized_email <> OLD.normalized_email
    OR NEW.token_key_version <> OLD.token_key_version
    OR NEW.token_digest <> OLD.token_digest
    OR NEW.created_at <> OLD.created_at
    OR NEW.expires_at <> OLD.expires_at
  THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'dasher_immutable';
  END IF;

  RETURN NEW;
END
$function$;

CREATE TRIGGER sign_in_challenges_consume_once
BEFORE UPDATE OR DELETE ON dasher.sign_in_challenges
FOR EACH ROW
EXECUTE FUNCTION dasher_private.guard_sign_in_challenge_update();

ALTER TABLE dasher.sign_in_challenges ENABLE ROW LEVEL SECURITY;

-- No policy and no grant, deliberately. The application role cannot read or
-- write this table at all: it is consulted BEFORE there is a principal, so a
-- row-security policy keyed on the request context could not express the right
-- rule anyway. Everything goes through the two `dasher_api` functions below,
-- which is what keeps "a challenge is single-use" and "a challenge is only
-- created for an active membership" properties of the schema.
--
-- `token_digest` in particular is never readable by the application. Anything
-- that could read it could redeem a link it never received.

-- ---------------------------------------------------------------------------
-- The seam
--
-- These two functions are the first in `dasher_api` that do NOT call
-- `acting_principal`, and they cannot: sign-in is what produces the principal
-- everything else requires. That makes them the schema's only pre-authentication
-- surface, so each is written to do exactly one thing and to decide, itself,
-- who it is willing to act for.
-- ---------------------------------------------------------------------------

-- How many links one address may request per hour before the answer is simply
-- no. A person who did not get the first email asks again; five is generous for
-- that and useless as an amplifier for mailing somebody else's inbox.
CREATE FUNCTION dasher_private.sign_in_hourly_limit()
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $function$ SELECT 5 $function$;

/*
 * Create a challenge for an address, if that address may sign in at all.
 *
 * RETURNS NULL for every reason a link is not being sent: no such identity, no
 * active membership, too many requests this hour. The caller cannot tell them
 * apart, and must not — the sign-in form says the same sentence either way, so
 * that submitting an address is not a way to ask whether it has an account
 * here. Returning distinct codes would put an enumeration oracle on an
 * unauthenticated endpoint.
 *
 * The token itself is never seen here. The caller generates it, sends it, and
 * passes only its SHA-256, exactly as invitations and sessions work.
 */
CREATE FUNCTION dasher_api.begin_sign_in(
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

/*
 * Redeem a link, once, and issue the session it earns.
 *
 * Every refusal is the same refusal: NULL. An expired link, a consumed link, a
 * link whose membership was revoked since it was sent, and a token that was
 * never issued are indistinguishable to the caller, because the page they all
 * lead to is the same page.
 *
 * `FOR UPDATE` is what makes single use real rather than likely. Two requests
 * arriving with the same link — a mail client prefetching it while the reader
 * clicks — serialize on the row, and the second sees `consumed_at` already set.
 */
CREATE FUNCTION dasher_api.redeem_sign_in(
  p_token_key_version smallint,
  p_token_digest bytea,
  p_session_token_key_version smallint,
  p_session_token_digest bytea,
  p_session_csrf_key_version smallint,
  p_session_csrf_digest bytea,
  p_idle_minutes integer,
  p_absolute_minutes integer,
  p_request_id uuid,
  p_deployment_revision text
)
RETURNS TABLE (session_id uuid, organization_id uuid, user_id uuid)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  challenge dasher.sign_in_challenges%ROWTYPE;
  member_revision bigint;
  new_session uuid := pg_catalog.gen_random_uuid();
BEGIN
  SELECT * INTO challenge
  FROM dasher.sign_in_challenges AS candidate
  WHERE candidate.token_key_version = p_token_key_version
    AND candidate.token_digest = p_token_digest
  FOR UPDATE;

  IF NOT FOUND
    OR challenge.consumed_at IS NOT NULL
    OR challenge.expires_at <= pg_catalog.clock_timestamp()
  THEN
    RETURN;
  END IF;

  -- Re-checked at redemption, not trusted from when the link was sent. A
  -- membership revoked in between must not be re-established by a link that was
  -- valid when it was posted.
  SELECT member.authority_revision INTO member_revision
  FROM dasher.memberships AS member
  WHERE member.organization_id = challenge.organization_id
    AND member.user_id = challenge.user_id
    AND member.state = 'active';

  IF member_revision IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO dasher.sessions (
    session_id, organization_id, user_id, authority_revision,
    token_key_version, token_digest, csrf_key_version, csrf_digest,
    issued_at, last_seen_at, idle_expires_at, absolute_expires_at
  )
  VALUES (
    new_session, challenge.organization_id, challenge.user_id, member_revision,
    p_session_token_key_version, p_session_token_digest,
    p_session_csrf_key_version, p_session_csrf_digest,
    pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
    -- `sessions_idle_expiry_check` requires idle <= absolute, so the idle
    -- window is clamped rather than assumed.
    pg_catalog.clock_timestamp() + pg_catalog.make_interval(
      mins => LEAST(p_idle_minutes, p_absolute_minutes)
    ),
    pg_catalog.clock_timestamp() + pg_catalog.make_interval(
      mins => p_absolute_minutes
    )
  );

  UPDATE dasher.sign_in_challenges AS held
  SET consumed_at = pg_catalog.clock_timestamp(),
      consumed_session_id = new_session
  WHERE held.challenge_id = challenge.challenge_id;

  INSERT INTO dasher.audit_events (
    audit_event_id, organization_id, actor_kind, actor_user_id,
    authority_revision, request_id, action, target_type, target_id,
    outcome, content_sha256, deployment_revision
  )
  VALUES (
    pg_catalog.gen_random_uuid(), challenge.organization_id, 'user',
    challenge.user_id, member_revision, p_request_id, 'session.issued',
    'session', new_session, 'succeeded', NULL, p_deployment_revision
  );

  session_id := new_session;
  organization_id := challenge.organization_id;
  user_id := challenge.user_id;
  RETURN NEXT;
END
$function$;

-- `sign_in.requested` is new; the rest of the vocabulary is unchanged. The
-- constraint is replaced rather than relaxed, so an action outside the list is
-- still rejected.
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
      'agent_run.finished'
    )
  );

REVOKE ALL ON dasher.sign_in_challenges FROM PUBLIC, dasher_app;
REVOKE ALL ON FUNCTION dasher_private.email_link_issuer() FROM PUBLIC;
REVOKE ALL ON FUNCTION dasher_private.sign_in_hourly_limit() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION dasher_api.begin_sign_in(
  text, smallint, bytea, timestamptz, uuid, text
) TO dasher_app;
GRANT EXECUTE ON FUNCTION dasher_api.redeem_sign_in(
  smallint, bytea, smallint, bytea, smallint, bytea, integer, integer, uuid,
  text
) TO dasher_app;
