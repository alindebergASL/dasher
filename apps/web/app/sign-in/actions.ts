"use server";

import { randomUUID } from "node:crypto";

import { beginSignIn, encodeSignInToken } from "@dasher/control-plane";
import { headers } from "next/headers";

import { getPool, isPersistenceConfigured } from "../database";
import { mailer, publicOrigin, signInLink, MailerError } from "../mailer";
import { clientKey, SlidingWindowThrottle } from "./throttle";

/** Per-client cap on link requests, so one address cannot be locked out by a stranger. */
const THROTTLE_KEY = Symbol.for("dasher.web.signInThrottle");
interface ThrottleCarrier {
  [THROTTLE_KEY]?: SlidingWindowThrottle;
}
function throttle(): SlidingWindowThrottle {
  const carrier = globalThis as ThrottleCarrier;
  carrier[THROTTLE_KEY] ??= new SlidingWindowThrottle(20, 60 * 60 * 1_000);
  return carrier[THROTTLE_KEY];
}

/**
 * Ask for a sign-in link.
 *
 * THE ONE THING THIS MUST NOT DO is tell the caller whether the address it was
 * given can sign in. `beginSignIn` returns `undefined` for an unknown address,
 * a revoked membership, a malformed address and a rate-limited one precisely so
 * that this layer has nothing to leak; the work here is to keep that true by
 * rendering one sentence for all of them AND for success.
 *
 * That includes failures on our side. If the mail provider rejects the send,
 * the person still sees the same sentence — because the alternative reveals
 * that the address was real enough to attempt delivery for. The failure is
 * raised into the server log, where it belongs, rather than into the page.
 */

export type SignInResult =
  { readonly ok: true } | { readonly ok: false; readonly error: string };

export async function requestSignInLink(
  formData: FormData,
): Promise<SignInResult> {
  const email = String(formData.get("email") ?? "");

  if (!isPersistenceConfigured()) {
    // A real state rather than an error: the fixture demo runs with no database
    // and always has. Saying so is not an information leak, because it is true
    // of every address equally.
    return {
      ok: false,
      error: "Sign-in is unavailable: this deployment has no database.",
    };
  }

  const transport = mailer();
  if (transport === undefined) {
    return {
      ok: false,
      error:
        "Sign-in is unavailable: this deployment has no mail transport configured.",
    };
  }

  // The origin is resolved BEFORE any challenge is raised. It throws when
  // `DASHER_PUBLIC_ORIGIN` is unset, unparseable, or a non-HTTPS host — and
  // inside the try below that failure was handled by the branch written for
  // "the provider rejected the send", so a misconfigured deployment spent a
  // challenge row and one of the address's five hourly slots, sent nothing, and
  // said a link was on its way. Checked first, it is what it is: this
  // deployment cannot send a link to anybody.
  try {
    // The value is not needed here — `signInLink` resolves it again when it
    // builds the URL. What matters is that it is resolvable BEFORE a challenge
    // is raised, so a misconfigured deployment refuses instead of spending one.
    publicOrigin();
  } catch {
    return {
      ok: false,
      error:
        "Sign-in is unavailable: this deployment has no public address configured.",
    };
  }

  if (!throttle().allow(clientKey(await headers()))) {
    return {
      ok: false,
      error:
        "Too many sign-in requests from this connection. Try again in an hour.",
    };
  }

  const requestId = randomUUID();
  const deploymentRevision = process.env["DASHER_DEPLOYMENT_REVISION"] ?? "dev";

  const issued = await beginSignIn(getPool(), {
    email,
    requestId,
    deploymentRevision,
  });

  // Nothing to send, and nothing to say about why.
  if (issued === undefined) return { ok: true };

  // NOT AWAITED, and that is the point.
  //
  // Awaiting the send made the response time itself the answer: an unknown
  // address returned after one local database round trip, a known one only
  // after Resend answered — a hundred milliseconds or more, one probe per
  // address, no statistics needed. Three comments in this codebase claim the
  // two are indistinguishable from outside; awaiting made that true of the
  // return value and false of the response.
  //
  // Handing the promise off means both branches return after the same database
  // work. This runs on a long-lived Node server, so the send completes after
  // the action returns; on a platform that froze the process at response time
  // it would need a queue instead, and there is no such platform here.
  //
  // An honest residual: the two branches still do different amounts of
  // DATABASE work — a known address inserts a challenge and an audit row where
  // an unknown one stops after the identity lookup. That difference is
  // sub-millisecond against a local socket rather than a network round trip,
  // and it is not claimed to be zero.
  void transport
    .sendSignInLink(
      // The normalised address, not the raw string the form carried.
      issued.normalizedEmail,
      signInLink(encodeSignInToken(issued.token)),
    )
    .catch((error: unknown) => {
      // Logged without the link. A delivery failure that surfaced to the caller
      // would answer "is this address known here?" for anyone willing to break
      // our mail provider.
      console.error(
        "sign-in link delivery failed",
        error instanceof MailerError ? error.code : "unknown",
      );
    });

  return { ok: true };
}
