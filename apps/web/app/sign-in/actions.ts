"use server";

import { randomUUID } from "node:crypto";

import { beginSignIn, encodeSignInToken } from "@dasher/control-plane";

import { getPool, isPersistenceConfigured } from "../database";
import { mailer, signInLink, MailerError } from "../mailer";

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

  const requestId = randomUUID();
  const deploymentRevision = process.env["DASHER_DEPLOYMENT_REVISION"] ?? "dev";

  const issued = await beginSignIn(getPool(), {
    email,
    requestId,
    deploymentRevision,
  });

  // Nothing to send, and nothing to say about why.
  if (issued === undefined) return { ok: true };

  try {
    await transport.sendSignInLink(
      email,
      signInLink(encodeSignInToken(issued.token)),
    );
  } catch (error) {
    // Logged without the link, and reported to the caller as success. A
    // delivery failure that rendered differently would answer "is this address
    // known here?" for anyone willing to break our mail provider.
    console.error(
      "sign-in link delivery failed",
      error instanceof MailerError ? error.code : "unknown",
    );
  }

  return { ok: true };
}
