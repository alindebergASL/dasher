import { cookies } from "next/headers";

/**
 * The request's session credential, read from the cookie the browser presents.
 *
 * WHAT IS AND IS NOT TRUSTED HERE. Nothing on this side decides who the caller
 * is. The cookie carries an opaque token; `dasher_api.begin_request` is what
 * turns it into a principal, and it does so by digest comparison against a
 * stored session row. This module's whole job is to move bytes from a header
 * into a `Buffer` and refuse anything that cannot possibly be a token.
 *
 * The name is fixed by `@dasher/control-plane`'s cookie seam rather than
 * restated: a second copy of a cookie name is a second thing to keep in step,
 * and the failure of drifting apart is silent — the browser holds a cookie the
 * server never looks for.
 */

/** Matches `sessionCookieName` in `@dasher/control-plane/session-cookie`. */
export const SESSION_COOKIE_NAME = "__Host-dasher_session";

/** The key version the seed and the bootstrap both issue under. */
const TOKEN_KEY_VERSION = 1;

/** The seam refuses anything shorter; checking here avoids a pointless round trip. */
const MINIMUM_TOKEN_BYTES = 16;

export interface SessionCredential {
  readonly tokenKeyVersion: number;
  readonly token: Buffer;
}

/**
 * `undefined` when there is no usable cookie — which is an ordinary state, not
 * an error. The fixture demo runs without a session and always has.
 */
export async function readSessionCredential(): Promise<
  SessionCredential | undefined
> {
  const store = await cookies();
  const raw = store.get(SESSION_COOKIE_NAME)?.value;
  if (raw === undefined || raw.trim() === "") return undefined;

  let token: Buffer;
  try {
    token = Buffer.from(raw, "base64url");
  } catch {
    return undefined;
  }
  if (token.length < MINIMUM_TOKEN_BYTES) return undefined;

  return { tokenKeyVersion: TOKEN_KEY_VERSION, token };
}

/** How the bootstrap encodes a token for the cookie. Kept beside the decoder. */
export function encodeSessionToken(token: Buffer): string {
  return token.toString("base64url");
}
