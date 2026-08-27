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
 * Redeem a confirmed sign-in link.
 *
 * POST ONLY, and the token comes from the body rather than the URL. Together
 * those are what stop a link from signing somebody in without their say-so: a
 * top-level navigation cannot reach this, and neither can a mail scanner
 * following the URL in the message.
 *
 * WHY IT REDIRECTS RATHER THAN RENDERING. The token was in the previous page's
 * form; nothing should keep it in an address bar, in history, or in the
 * `Referer` of everything on the page that follows. A 303 also makes the
 * browser follow with GET rather than re-POSTing.
 *
 * WHY EVERY FAILURE IS THE SAME REDIRECT. Expired, already used, revoked since
 * it was sent, never issued, malformed — all land on `/sign-in?failed=1`.
 * Distinguishing them would tell whoever is holding the link things the person
 * who lost it already knows.
 */

const SESSION_MINUTES = 12 * 60;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const failed = NextResponse.redirect(
    new URL("/sign-in?failed=1", request.url),
    { status: 303 },
  );

  if (!isPersistenceConfigured()) return failed;

  let raw: string | undefined;
  try {
    const form = await request.formData();
    const value = form.get("token");
    raw = typeof value === "string" ? value : undefined;
  } catch {
    return failed;
  }
  if (raw === undefined) return failed;

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

  const response = NextResponse.redirect(new URL("/", request.url), {
    status: 303,
  });
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
