import { randomUUID } from "node:crypto";

import { revokeSession } from "@dasher/control-plane";
import { NextResponse, type NextRequest } from "next/server";

import { getPool, isPersistenceConfigured } from "../database";
import { readSessionCredential, SESSION_COOKIE_NAME } from "../session";

/**
 * End the session and clear the cookie.
 *
 * WHY POST ONLY. A GET that revokes is a state change any page, email, or image
 * tag can trigger — `<img src="/sign-out">` in a forum post would sign out
 * every reader who loaded it. Signing someone out is a small harm, but it is a
 * harm delivered by somebody else, which is the definition this rule exists
 * for.
 *
 * WHY THE COOKIE IS CLEARED WHETHER OR NOT ANYTHING WAS REVOKED. The revoke
 * returns false for a session already ended and for a token never issued. In
 * both cases the browser is holding a credential the server will not honour,
 * and leaving it there so the header can keep offering "Sign out" helps
 * nobody. The clear is the part the person asked for; the revoke is the part
 * that matters to everyone else. (An expired session returns TRUE — the seam
 * marks it rather than refusing — so this branch is not a test of liveness.)
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const response = NextResponse.redirect(new URL("/", request.url), {
    // 303, so the browser follows with GET rather than re-POSTing to `/`.
    status: 303,
  });

  const credential = await readSessionCredential();
  if (credential !== undefined && isPersistenceConfigured()) {
    try {
      await revokeSession(getPool(), credential.token, {
        reason: "signed_out",
        requestId: randomUUID(),
        deploymentRevision: process.env["DASHER_DEPLOYMENT_REVISION"] ?? "dev",
      });
    } catch {
      // The database being unreachable must not leave somebody holding a
      // cookie they asked to be rid of. The session stays live server-side and
      // will expire on its own; the browser stops presenting it now.
    }
  }

  response.cookies.set({
    name: SESSION_COOKIE_NAME,
    value: "",
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return response;
}
