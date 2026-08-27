import type { Metadata } from "next";

import { SignInForm } from "../../components/sign-in-form";

export const metadata: Metadata = { title: "Sign in — Dasher" };

/**
 * The sign-in page.
 *
 * `failed=1` is the only thing the verify route tells this page, and it means
 * exactly "that link did not work". Which of the five reasons it was is
 * deliberately not carried: they are the same answer to somebody holding a link
 * they should not have, and the person who lost it already knows which.
 */
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;

  return (
    <main className="sign-in-main">
      <section className="sign-in-panel" aria-labelledby="sign-in-heading">
        <h1 className="sign-in-heading" id="sign-in-heading">
          Sign in to Dasher
        </h1>
        <p className="sign-in-note">
          Dasher sends a link rather than asking for a password. There is
          nothing to remember and nothing for us to lose.
        </p>

        {params["failed"] === undefined ? null : (
          <p className="request-error" role="alert">
            That link did not work. It may have been used already, or it may
            have expired — links last 15 minutes and work once. Ask for another
            below.
          </p>
        )}

        <SignInForm />

        <p className="sign-in-note">
          Access is by invitation while Dasher is in pilot. If your organization
          has not been set up yet, a link will not arrive.
        </p>
      </section>
    </main>
  );
}
