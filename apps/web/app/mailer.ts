/**
 * How a sign-in link reaches a person.
 *
 * WHY THE DEVELOPMENT TRANSPORT IS NOT A FALLBACK. The obvious shape — use the
 * mail provider if it is configured, otherwise print the link to the log — puts
 * a magic link into stdout on any deployment whose provider credentials are
 * missing or misspelled. That is a live session token in a log aggregator,
 * arriving silently, on exactly the day somebody fumbled the configuration. So
 * the transport is CHOSEN by name: `DASHER_MAIL_TRANSPORT=log` is a deliberate
 * statement, and anything else with no provider configured means sign-in is
 * unavailable rather than insecure.
 *
 * WHY THE LINK IS BUILT FROM CONFIGURATION RATHER THAN THE REQUEST. Taking the
 * origin from the `Host` header would let anyone who can set that header decide
 * where the link points — the classic host-header poisoning route to sending a
 * valid token to an attacker's domain. `DASHER_PUBLIC_ORIGIN` is the one place
 * that answer comes from.
 */

import {
  SendEmailCommand,
  SESv2Client,
  type SendEmailCommandInput,
} from "@aws-sdk/client-sesv2";
import { SIGN_IN_LINK_MINUTES } from "@dasher/control-plane";

export type MailerErrorCode =
  "not_configured" | "delivery_failed" | "invalid_origin";

export class MailerError extends Error {
  readonly code: MailerErrorCode;

  constructor(code: MailerErrorCode, message: string) {
    super(message);
    this.name = "MailerError";
    this.code = code;
  }
}

export interface SignInMailer {
  /** The transport's name, for a startup log line that carries no secret. */
  readonly transport: "resend" | "ses" | "log";
  sendSignInLink(recipient: string, link: string): Promise<void>;
}

export interface SesMailClient {
  send(command: SendEmailCommand): Promise<unknown>;
}

/**
 * The origin sign-in links are built from.
 *
 * Required to be HTTPS, because the session cookie this eventually sets carries
 * the `__Host-` prefix and `secure`: a link on an `http://` origin produces a
 * session the browser then refuses to store, which would look like a broken
 * sign-in rather than a misconfiguration. `http://localhost` is the exception
 * browsers themselves make, so it is the exception here too.
 */
export function publicOrigin(): string {
  const raw = process.env["DASHER_PUBLIC_ORIGIN"];
  if (raw === undefined || raw.trim() === "") {
    throw new MailerError(
      "invalid_origin",
      "DASHER_PUBLIC_ORIGIN is not set, so a sign-in link cannot be addressed",
    );
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new MailerError(
      "invalid_origin",
      "DASHER_PUBLIC_ORIGIN is not a URL",
    );
  }

  const isLocalhost =
    url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !isLocalhost) {
    throw new MailerError(
      "invalid_origin",
      "DASHER_PUBLIC_ORIGIN must be https, because the session cookie is Secure",
    );
  }

  return url.origin;
}

export function signInLink(token: string): string {
  return `${publicOrigin()}/sign-in/verify?token=${encodeURIComponent(token)}`;
}

/**
 * The body of the email.
 *
 * Deliberately says how long the link lasts and that it can be used once, so a
 * person who clicks it twice understands what happened rather than concluding
 * the product is broken. It says nothing about who requested it, because the
 * recipient may not be the requester.
 */
export function signInEmail(
  link: string,
  minutes: number = SIGN_IN_LINK_MINUTES,
) {
  return {
    subject: "Your Dasher sign-in link",
    text: [
      "Someone asked for a link to sign in to Dasher with this address.",
      "",
      link,
      "",
      `The link works once and expires in ${String(minutes)} minutes.`,
      "If it was not you, nothing has happened and you can ignore this.",
    ].join("\n"),
  };
}

function resendMailer(apiKey: string, from: string): SignInMailer {
  return {
    transport: "resend",
    async sendSignInLink(recipient, link) {
      const message = signInEmail(link);
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from,
          to: [recipient],
          subject: message.subject,
          text: message.text,
        }),
      });

      if (!response.ok) {
        // The status, and nothing else. A provider's error body can quote the
        // request it was sent, which here contains the link.
        throw new MailerError(
          "delivery_failed",
          `the mail provider answered ${String(response.status)}`,
        );
      }
    },
  };
}

/**
 * SES through the AWS credential chain. On EC2 this means the instance role;
 * no long-lived mail credential belongs in `deploy/.env`.
 */
export function sesMailer(client: SesMailClient, from: string): SignInMailer {
  return {
    transport: "ses",
    async sendSignInLink(recipient, link) {
      const message = signInEmail(link);
      const input: SendEmailCommandInput = {
        FromEmailAddress: from,
        Destination: { ToAddresses: [recipient] },
        Content: {
          Simple: {
            Subject: { Data: message.subject, Charset: "UTF-8" },
            Body: { Text: { Data: message.text, Charset: "UTF-8" } },
          },
        },
      };
      try {
        await client.send(new SendEmailCommand(input));
      } catch {
        // No provider body, address, or link in the error crossing this seam.
        throw new MailerError("delivery_failed", "SES delivery failed");
      }
    },
  };
}

function logMailer(): SignInMailer {
  return {
    transport: "log",
    sendSignInLink(recipient, link) {
      // Only ever reached when DASHER_MAIL_TRANSPORT=log was set on purpose.
      process.stdout.write(
        `\n[dev mail] sign-in link for ${recipient}:\n  ${link}\n\n`,
      );
      return Promise.resolve();
    },
  };
}

/**
 * `undefined` when no transport is configured, which makes sign-in unavailable
 * rather than silently insecure. The caller renders that as its own state.
 */
export function mailer(): SignInMailer | undefined {
  const choice = process.env["DASHER_MAIL_TRANSPORT"]?.trim();
  if (choice === "log") return logMailer();

  const from = process.env["DASHER_MAIL_FROM"];
  if (choice === "ses") {
    const region = process.env["AWS_REGION"]?.trim();
    if (
      from === undefined ||
      from.trim() === "" ||
      region === undefined ||
      region === ""
    ) {
      return undefined;
    }
    return sesMailer(new SESv2Client({ region }), from);
  }

  // Preserve the established Resend configuration when the transport is unset;
  // any other named transport fails closed rather than guessing.
  if (choice !== undefined && choice !== "" && choice !== "resend") {
    return undefined;
  }

  const apiKey = process.env["DASHER_RESEND_API_KEY"];
  if (
    apiKey === undefined ||
    apiKey.trim() === "" ||
    from === undefined ||
    from.trim() === ""
  ) {
    return undefined;
  }
  return resendMailer(apiKey, from);
}
