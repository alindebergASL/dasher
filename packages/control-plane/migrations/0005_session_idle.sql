-- One session idle window.
--
-- `redeem_sign_in` takes the idle window from the application (sixty minutes,
-- `SESSION_IDLE_MINUTES` in `sign-in.ts`); `begin_request` refreshes it on every
-- request. The two must agree, so the refresh reads the value from one immutable
-- function rather than carrying a literal of its own.
--
-- `begin_request` is replaced with its baseline body, differing only in that
-- expression. Its grants survive CREATE OR REPLACE and are not restated.

/*
 * Minutes of inactivity after which a session lapses. The application passes
 * the same value at issue time; this is where it lives for the schema.
 */
CREATE FUNCTION dasher_private.session_idle_minutes()
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $function$ SELECT 60 $function$;

REVOKE ALL ON FUNCTION dasher_private.session_idle_minutes() FROM PUBLIC;

CREATE OR REPLACE FUNCTION dasher_api.begin_request(
  p_token_key_version smallint,
  p_token bytea
)
RETURNS TABLE (user_id uuid, organization_id uuid)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  session_row dasher.sessions%ROWTYPE;
  membership_row dasher.memberships%ROWTYPE;
  now_at timestamptz := pg_catalog.clock_timestamp();
  presented_digest bytea;
BEGIN
  -- The caller presents the opaque token; the verifier is derived here. If the
  -- stored digest were the input, then anything able to read that column could
  -- authenticate as the session it belongs to, which makes a verifier into a
  -- credential. Reproduced before this was changed: a caller holding one
  -- session read a second session's stored digest and authenticated as it,
  -- after its own session had been revoked.
  IF p_token IS NULL OR pg_catalog.octet_length(p_token) < 16 THEN
    RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = 'dasher_denied';
  END IF;
  presented_digest := pg_catalog.sha256(p_token);

  -- Validate and refresh in one statement. Reading first and updating on the
  -- session id alone left a race: blocked behind a concurrent revocation, the
  -- update re-evaluated its predicate against the new row version, still
  -- matched on id, and stamped a context for a session already revoked. Every
  -- validity condition now lives in the predicate that takes the row lock, so
  -- resuming after such a commit finds nothing to update.
  UPDATE dasher.sessions AS live
  SET last_seen_at = now_at,
      idle_expires_at = LEAST(
        now_at + pg_catalog.make_interval(
          mins => dasher_private.session_idle_minutes()
        ),
        live.absolute_expires_at
      )
  WHERE live.token_key_version = p_token_key_version
    AND live.token_digest = presented_digest
    AND live.revoked_at IS NULL
    AND now_at < live.idle_expires_at
    AND now_at < live.absolute_expires_at
  RETURNING * INTO session_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = 'dasher_denied';
  END IF;

  -- Deliberately not locked. Holding a share lock here for the life of the
  -- request would make every role change and revocation queue behind in-flight
  -- requests, which is worse than the window it closes: if the membership moves
  -- after this read, `context_allows` denies on the authority mismatch at the
  -- next statement anyway.
  --
  -- The membership must still be active *and* unchanged since the session was
  -- issued. A role change or revocation bumps authority_revision, which
  -- invalidates every session issued under the old authority.
  SELECT * INTO membership_row
  FROM dasher.memberships AS candidate
  WHERE candidate.organization_id = session_row.organization_id
    AND candidate.user_id = session_row.user_id;

  IF NOT FOUND
    OR membership_row.state <> 'active'
    OR membership_row.authority_revision <> session_row.authority_revision
  THEN
    RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = 'dasher_denied';
  END IF;

  -- The UPDATE above has assigned this transaction an identifier, which the
  -- digest below binds to. All five settings are transaction-local.
  PERFORM pg_catalog.set_config(
    'dasher.context_user_id', session_row.user_id::text, true
  );
  PERFORM pg_catalog.set_config(
    'dasher.context_organization_id',
    session_row.organization_id::text,
    true
  );
  PERFORM pg_catalog.set_config(
    'dasher.context_session_id', session_row.session_id::text, true
  );
  PERFORM pg_catalog.set_config(
    'dasher.context_authority',
    membership_row.authority_revision::text,
    true
  );
  PERFORM pg_catalog.set_config(
    'dasher.context_digest',
    pg_catalog.encode(
      dasher_private.context_digest(
        session_row.user_id,
        session_row.organization_id,
        session_row.session_id,
        membership_row.authority_revision,
        pg_catalog.pg_current_xact_id()::text
      ),
      'hex'
    ),
    true
  );

  user_id := session_row.user_id;
  organization_id := session_row.organization_id;
  RETURN NEXT;
END
$function$;
