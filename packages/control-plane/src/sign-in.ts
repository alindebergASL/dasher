import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { normalizeEmailAddress } from "./email";
import type { RequestPool } from "./request-context";

/**
 * Passwordless sign-in: request a link, redeem it once, get a session.
 *
 * WHY THIS DOES NOT GO THROUGH `withRequestContext`. Every other operation in
 * this package runs inside a request context, because every other operation
 * needs a principal to decide what it may touch. Sign-in is what PRODUCES that
 * principal, so there is nothing to set the context from. The two seam
 * functions it calls are the schema's only pre-authentication surface, and each
 * decides for itself who it is willing to act for — which is why the
 * application role holds no rights on `sign_in_challenges` at all and cannot
 * read a token digest even in principle.
 *
 * WHAT NEVER LEAVES THIS MODULE. The raw token exists in one place, for one
 * purpose: it is generated here, returned to the caller to be emailed, and
 * never stored. The database receives only its SHA-256, exactly as sessions and
 * invitations work. A digest that could be read back would be a credential.
 */

/** 32 bytes from the CSPRNG. The link is the whole credential; it is not short. */
const TOKEN_BYTES = 32;

/**
 * Fifteen minutes.
 *
 * Long enough to walk to another device and open the mail, short enough that a
 * link sitting in an inbox, a forwarded thread, or a mail-server log stops
 * being usable quickly. It is not the session lifetime — the session it issues
 * outlives it by a lot — so shortening this costs a reader nothing but a second
 * request.
 */
export const SIGN_IN_LINK_MINUTES = 15;

const SESSION_IDLE_MINUTES = 60;
const SESSION_ABSOLUTE_MINUTES = 12 * 60;

/** Matches the key version every other token in this schema is issued under. */
const KEY_VERSION = 1;

export interface SignInRequest {
  /** As the person typed it. Normalised here, not by the caller. */
  readonly email: string;
  readonly requestId: string;
  readonly deploymentRevision: string;
}

export interface IssuedSignInLink {
  readonly challengeId: string;
  /**
   * The address the challenge was actually raised for, normalised.
   *
   * Returned rather than left to the caller to re-derive, because the caller
   * holds the RAW string a person typed. Mailing that instead is a real
   * failure: `"  padded@example.com  "` raises a challenge for
   * `padded@example.com`, spends one of its five hourly slots, and then hands
   * the provider a recipient it rejects — so the link is never sent and the
   * person is told one is on its way.
   */
  readonly normalizedEmail: string;
  /**
   * The raw token, to be put in a link and emailed. Never persisted, never
   * logged, and not returned anywhere a browser can see it.
   */
  readonly token: Buffer;
}

export interface RedeemedSignIn {
  readonly sessionId: string;
  readonly organizationId: string;
  readonly userId: string;
  /** The session credential, for the cookie. */
  readonly sessionToken: Buffer;
}

function digest(value: Buffer): Buffer {
  return createHash("sha256").update(value).digest();
}

/**
 * Ask for a link.
 *
 * `undefined` for every reason a link is not being sent: the address has no
 * identity here, its membership is not active, it is not a well-formed address
 * at all, or it has asked too many times this hour. The caller MUST render the
 * same thing for `undefined` as for success — the seam returns one answer for
 * all of these precisely so that submitting an address cannot be used to ask
 * whether it has an account.
 */
export async function beginSignIn(
  pool: RequestPool,
  request: SignInRequest,
): Promise<IssuedSignInLink | undefined> {
  let normalized: string;
  try {
    // Trimmed here rather than inside `normalizeEmailAddress`, which rejects
    // surrounding whitespace on purpose and is the wrong place to relax: it is
    // the function that decides two strings are the same account. The cost of
    // not trimming here is a legitimate person pasting an address with a
    // trailing space, being told a link is on its way, and never getting one.
    normalized = normalizeEmailAddress(request.email.trim());
  } catch {
    // An unparseable address is not an error the person needs explained
    // differently from an unknown one. Both are "if that address can sign in,
    // a link is on its way".
    return undefined;
  }

  const token = randomBytes(TOKEN_BYTES);
  const expiresAt = new Date(Date.now() + SIGN_IN_LINK_MINUTES * 60 * 1_000);

  const client = await pool.connect();
  try {
    const result = await client.query<{ challenge_id: string | null }>(
      "SELECT dasher_api.begin_sign_in($1, $2, $3, $4, $5, $6) AS challenge_id",
      [
        normalized,
        KEY_VERSION,
        digest(token),
        expiresAt.toISOString(),
        request.requestId,
        request.deploymentRevision,
      ],
    );
    const challengeId = result.rows[0]?.challenge_id;
    return challengeId === null || challengeId === undefined
      ? undefined
      : { challengeId, normalizedEmail: normalized, token };
  } finally {
    client.release();
  }
}

/**
 * Redeem a link, once.
 *
 * `undefined` for an expired link, a link already used, a link whose membership
 * was revoked since it was sent, and a token that was never issued. They are
 * the same answer because they lead to the same page, and telling them apart
 * would say more to somebody holding a stolen link than to the person who lost
 * it.
 */
export async function redeemSignIn(
  pool: RequestPool,
  token: Buffer,
  context: { readonly requestId: string; readonly deploymentRevision: string },
): Promise<RedeemedSignIn | undefined> {
  // A token of the wrong length cannot be one this module issued, and checking
  // here keeps a malformed URL from reaching a query at all.
  if (token.length !== TOKEN_BYTES) return undefined;

  const sessionToken = randomBytes(TOKEN_BYTES);
  const csrfToken = randomBytes(TOKEN_BYTES);

  const client = await pool.connect();
  try {
    const result = await client.query<{
      session_id: string;
      organization_id: string;
      user_id: string;
    }>(
      `SELECT session_id, organization_id, user_id
         FROM dasher_api.redeem_sign_in($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        KEY_VERSION,
        digest(token),
        KEY_VERSION,
        digest(sessionToken),
        KEY_VERSION,
        digest(csrfToken),
        SESSION_IDLE_MINUTES,
        SESSION_ABSOLUTE_MINUTES,
        context.requestId,
        context.deploymentRevision,
      ],
    );

    const row = result.rows[0];
    if (row === undefined) return undefined;

    return {
      sessionId: row.session_id,
      organizationId: row.organization_id,
      userId: row.user_id,
      sessionToken,
    };
  } finally {
    client.release();
  }
}

/**
 * Decode a token from a link, without letting its shape leak through timing.
 *
 * The comparison this guards is done in the database against a digest, so the
 * constant-time work here is about the decode rather than the match: a
 * `base64url` string of the wrong length is rejected on length alone, which is
 * public information, and everything of the right length takes the same path.
 */
export function decodeSignInToken(raw: string): Buffer | undefined {
  if (raw.length === 0 || raw.length > 128) return undefined;
  let token: Buffer;
  try {
    token = Buffer.from(raw, "base64url");
  } catch {
    return undefined;
  }
  if (token.length !== TOKEN_BYTES) return undefined;
  // Re-encoding and comparing rejects a string that decodes to the right bytes
  // but is not the canonical encoding of them — standard base64, a padded
  // variant, anything a permissive decoder would accept.
  //
  // What that is NOT worth: redemption has no rate limit and writes no audit
  // row until it succeeds, so several spellings of one token could not consume
  // either. An earlier version of this comment said they could, which would
  // have told a reader auditing whether redemption is throttled that it is.
  // It is not — `POST /sign-in/confirm` is the endpoint that redeems, and
  // nothing in this module throttles it.
  //
  // What it IS worth: one token has one representation, so a link cannot be
  // reshaped into a different-looking URL that still works.
  const canonical = Buffer.from(token.toString("base64url"), "utf8");
  const presented = Buffer.from(raw, "utf8");
  if (canonical.length !== presented.length) return undefined;
  return timingSafeEqual(canonical, presented) ? token : undefined;
}

export function encodeSignInToken(token: Buffer): string {
  return token.toString("base64url");
}

/**
 * End a session by presenting it.
 *
 * Returns whether a row was marked, which the caller should use for logging and
 * not for what it renders: signing out has to look the same in every case. An
 * already-revoked session and a token that was never issued are `false`; an
 * EXPIRED one is `true`, because the seam marks it rather than refusing — so
 * this boolean means "a row was revoked", not "the session was live". The
 * cookie is cleared regardless, because a browser holding a credential the
 * server will not honour is worse than one holding none.
 */
export async function revokeSession(
  pool: RequestPool,
  token: Buffer,
  context: {
    readonly reason: string;
    readonly requestId: string;
    readonly deploymentRevision: string;
  },
): Promise<boolean> {
  if (token.length !== TOKEN_BYTES) return false;

  const client = await pool.connect();
  try {
    const result = await client.query<{ revoked: boolean }>(
      "SELECT dasher_api.revoke_session($1, $2, $3, $4, $5) AS revoked",
      [
        KEY_VERSION,
        digest(token),
        context.reason,
        context.requestId,
        context.deploymentRevision,
      ],
    );
    return result.rows[0]?.revoked === true;
  } finally {
    client.release();
  }
}
