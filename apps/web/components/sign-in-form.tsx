"use client";

import { useState, useTransition } from "react";

import { requestSignInLink } from "@/app/sign-in/actions";

/**
 * One field and one button.
 *
 * WHY THE SUCCESS SENTENCE IS A CONSTANT HERE. The server returns `ok` for a
 * link that was sent and for an address it will not send to, on purpose — so
 * this component must not have a second sentence to render. Holding the wording
 * on the client rather than passing it back from the action keeps that true by
 * construction: there is no channel for a different answer to arrive on.
 */
const SENT =
  "If that address can sign in, a link is on its way. It works once and expires in 15 minutes.";

export function SignInForm() {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [unavailable, setUnavailable] = useState<string | undefined>(undefined);

  return (
    <form
      className="sign-in-form"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        startTransition(async () => {
          const result = await requestSignInLink(data);
          if (result.ok) {
            setUnavailable(undefined);
            setMessage(SENT);
          } else {
            // The only case with its own wording, and it is true of every
            // address equally: this deployment cannot sign anyone in.
            setMessage(undefined);
            setUnavailable(result.error);
          }
        });
      }}
    >
      <label className="request-label" htmlFor="sign-in-email">
        Your email address
      </label>
      <input
        autoComplete="email"
        className="request-input"
        id="sign-in-email"
        inputMode="email"
        maxLength={320}
        name="email"
        required
        type="email"
      />

      <div className="request-row">
        <button className="request-submit" disabled={pending} type="submit">
          {pending ? "Sending…" : "Email me a link"}
        </button>
      </div>

      {message === undefined ? null : (
        <p className="sign-in-sent" role="status">
          {message}
        </p>
      )}
      {unavailable === undefined ? null : (
        <p className="request-error" role="alert">
          {unavailable}
        </p>
      )}
    </form>
  );
}
