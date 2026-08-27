import { randomUUID } from "node:crypto";

import {
  createSessionCookieMetadata,
  decodeSignInToken,
  redeemSignIn,
} from "@dasher/control-plane";
import { NextResponse, type NextRequest } from "next/server";

import { getPool, isPersistenceConfigured } from "../../database";
import { encodeSessionToken } from "../../session";

/**
 * Redeem a sign-in link and become somebody.
 *
 * WHY IT REDIRECTS INSTEAD OF RENDERING. The token is in the URL, and a page
 * rendered at that URL keeps it in the address bar, in history, and in the
 * `Referer` of every asset and link on it. Redirecting to `/` the moment the
 * session cookie is set means the token exists in the browser for one response.
 * It is single-use and already spent by then, which makes the window small; the
 * redirect makes it smaller for no cost.
 *
 * WHY EVERY FAILURE IS THE SAME REDIRECT. Expired, already used, revoked since
 * it was sent, never issued, malformed — all land on `/sign-in?failed=1`, which
 * says the link did not work and offers another. Distinguishing them would tell
 * whoever is holding the link things the person who lost it already knows.
 */

const SESSION_MINUTES = 12 * 60;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const failed = NextResponse.redirect(
    new URL("/sign-in?failed=1", request.url),
  );

  if (!isPersistenceConfigured()) return failed;

  const raw = request.nextUrl.searchParams.get("token");
  if (raw === null) return failed;

  const token = decodeSignInToken(raw);
  if (token === undefined) return failed;

  const redeemed = await redeemSignIn(getPool(), token, {
    requestId: randomUUID(),
    deploymentRevision: process.env["DASHER_DEPLOYMENT_REVISION"] ?? "dev",
  });
  if (redeemed === undefined) return failed;

  const now = Date.now();
  const cookie = createSessionCookieMetadata(
    now,
    now + SESSION_MINUTES * 60 * 1_000,
  );

  const response = NextResponse.redirect(new URL("/", request.url));
  response.cookies.set({
    name: cookie.name,
    value: encodeSessionToken(redeemed.sessionToken),
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    sameSite: cookie.sameSite,
    path: cookie.path,
    maxAge: cookie.maxAge,
  });
  return response;
}
