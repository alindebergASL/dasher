import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  mailer,
  publicOrigin,
  sesMailer,
  signInEmail,
  signInLink,
  MailerError,
} from "./mailer";

/**
 * The mail transport, and the two ways it could quietly become unsafe.
 *
 * Neither is about whether an email arrives. One is about a deployment whose
 * provider credentials are missing printing live sign-in links into its logs;
 * the other is about where a link points when somebody else controls the
 * request.
 */

const KEYS = [
  "DASHER_MAIL_TRANSPORT",
  "DASHER_RESEND_API_KEY",
  "DASHER_MAIL_FROM",
  "DASHER_PUBLIC_ORIGIN",
  "AWS_REGION",
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("mailer", () => {
  it("is unavailable rather than insecure when nothing is configured", () => {
    // THE defect this shape exists to prevent. The obvious alternative — fall
    // back to printing the link — puts a live session token into stdout on any
    // deployment whose provider credentials are missing or misspelled, silently,
    // on exactly the day somebody fumbled the configuration.
    expect(mailer()).toBeUndefined();
  });

  it("is still unavailable when the provider is half-configured", () => {
    process.env["DASHER_RESEND_API_KEY"] = "test-key";
    expect(mailer()).toBeUndefined();

    delete process.env["DASHER_RESEND_API_KEY"];
    process.env["DASHER_MAIL_FROM"] = "dasher@example.com";
    expect(mailer()).toBeUndefined();
  });

  it("treats a whitespace-only value as absent, on either half", () => {
    // A variable set to spaces is what a half-finished `.env` looks like, and
    // it is the shape that would otherwise construct a transport that cannot
    // authenticate or has no sender.
    process.env["DASHER_RESEND_API_KEY"] = "   ";
    process.env["DASHER_MAIL_FROM"] = "dasher@example.com";
    expect(mailer()).toBeUndefined();

    process.env["DASHER_RESEND_API_KEY"] = "test-key";
    process.env["DASHER_MAIL_FROM"] = "  ";
    expect(mailer()).toBeUndefined();
  });

  it("uses the provider once both halves are present", () => {
    process.env["DASHER_RESEND_API_KEY"] = "test-key";
    process.env["DASHER_MAIL_FROM"] = "dasher@example.com";
    expect(mailer()?.transport).toBe("resend");
  });

  it("uses SES only when it is named with a sender and region", () => {
    process.env["DASHER_MAIL_TRANSPORT"] = "ses";
    process.env["DASHER_MAIL_FROM"] = "noreply@luckbutton.com";
    process.env["DASHER_RESEND_API_KEY"] = "must-not-fallback";
    expect(mailer()).toBeUndefined();
    process.env["AWS_REGION"] = "us-west-2";
    expect(mailer()?.transport).toBe("ses");
  });

  it("accepts Resend by name and refuses an unknown named transport", () => {
    process.env["DASHER_RESEND_API_KEY"] = "test-key";
    process.env["DASHER_MAIL_FROM"] = "dasher@example.com";
    process.env["DASHER_MAIL_TRANSPORT"] = "resend";
    expect(mailer()?.transport).toBe("resend");
    process.env["DASHER_MAIL_TRANSPORT"] = "smtp";
    expect(mailer()).toBeUndefined();
  });

  it("prints to the log only when asked for by name", () => {
    // A deliberate statement, not a consequence of something being absent.
    process.env["DASHER_MAIL_TRANSPORT"] = "log";
    expect(mailer()?.transport).toBe("log");
  });

  it("does not accept a near-miss spelling as permission to log", () => {
    for (const value of ["Log", "LOG", "logger", "true", "1", ""]) {
      process.env["DASHER_MAIL_TRANSPORT"] = value;
      expect(mailer(), value).toBeUndefined();
    }
  });

  it("prefers the log transport over a configured provider when named", () => {
    // Local development against a real key in the environment should not send
    // real email; naming the transport is how somebody says so.
    process.env["DASHER_MAIL_TRANSPORT"] = "log";
    process.env["DASHER_RESEND_API_KEY"] = "test-key";
    process.env["DASHER_MAIL_FROM"] = "dasher@example.com";
    expect(mailer()?.transport).toBe("log");
  });
});

describe("publicOrigin", () => {
  it("refuses to guess", () => {
    // Taking the origin from the request's Host header is the classic route to
    // mailing a valid token to somebody else's domain.
    expect(() => publicOrigin()).toThrow(MailerError);
  });

  it("requires https, because the session cookie is Secure", () => {
    process.env["DASHER_PUBLIC_ORIGIN"] = "http://dasher.example.com";
    expect(() => publicOrigin()).toThrow(/https/u);
  });

  it("makes the same exception for localhost that browsers do", () => {
    process.env["DASHER_PUBLIC_ORIGIN"] = "http://localhost:3000";
    expect(publicOrigin()).toBe("http://localhost:3000");
    process.env["DASHER_PUBLIC_ORIGIN"] = "http://127.0.0.1:3000";
    expect(publicOrigin()).toBe("http://127.0.0.1:3000");
  });

  it("keeps only the origin, discarding any path it was given", () => {
    process.env["DASHER_PUBLIC_ORIGIN"] = "https://dasher.example.com/app/";
    expect(publicOrigin()).toBe("https://dasher.example.com");
  });

  it("refuses a value that is not a URL", () => {
    process.env["DASHER_PUBLIC_ORIGIN"] = "dasher.example.com";
    expect(() => publicOrigin()).toThrow(MailerError);
  });

  it("treats a whitespace-only origin as unset", () => {
    process.env["DASHER_PUBLIC_ORIGIN"] = "   ";
    expect(() => publicOrigin()).toThrow(/not set/u);
  });
});

describe("signInLink", () => {
  it("escapes the token rather than pasting it into a URL", () => {
    process.env["DASHER_PUBLIC_ORIGIN"] = "https://dasher.example.com";
    // base64url produces no character needing escaping, which is exactly why
    // the encoding is asserted rather than assumed: the day a token encoding
    // changes, an unescaped `+` or `/` silently becomes a different token.
    expect(signInLink("abc-_123")).toBe(
      "https://dasher.example.com/sign-in/verify?token=abc-_123",
    );
    expect(signInLink("a+b/c=")).toBe(
      "https://dasher.example.com/sign-in/verify?token=a%2Bb%2Fc%3D",
    );
  });
});

describe("signInEmail", () => {
  it("says the link is single use and how long it lasts", () => {
    // Somebody who clicks twice should understand what happened rather than
    // conclude the product is broken.
    const body = signInEmail("https://dasher.example.com/x").text;
    expect(body).toContain("works once");
    expect(body).toContain("15 minutes");
    expect(body).toContain("https://dasher.example.com/x");
  });

  it("says nothing about who asked", () => {
    // The recipient may not be the requester, and telling them an address or a
    // name would make an unsolicited link into a disclosure.
    const body = signInEmail("https://dasher.example.com/x").text;
    expect(body).toContain("If it was not you");
    expect(body).not.toMatch(/@/u);
  });
});

describe("the provider transport", () => {
  beforeEach(() => {
    process.env["DASHER_RESEND_API_KEY"] = "test-key";
    process.env["DASHER_MAIL_FROM"] = "Dasher <dasher@example.com>";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts the message to the provider with its credential", async () => {
    // Asserted rather than assumed because none of it fails loudly: a wrong
    // path, a missing authorization header, or `to` as a string instead of an
    // array all produce a non-2xx that this deployment reports as "a link is on
    // its way", because a delivery failure must not be distinguishable from an
    // address we will not mail.
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await mailer()!.sendSignInLink(
      "person@example.com",
      "https://dasher.example.com/sign-in/verify?token=abc",
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["authorization"]).toBe(
      "Bearer test-key",
    );
    expect((init.headers as Record<string, string>)["content-type"]).toBe(
      "application/json",
    );

    const body = JSON.parse(String(init.body)) as {
      from: string;
      to: string[];
      subject: string;
      text: string;
    };
    expect(body.from).toBe("Dasher <dasher@example.com>");
    expect(body.to).toEqual(["person@example.com"]);
    expect(body.subject).toBe("Your Dasher sign-in link");
    expect(body.text).toContain(
      "https://dasher.example.com/sign-in/verify?token=abc",
    );
  });

  it("raises a delivery failure the caller can recognise", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("nope", { status: 422 })),
    );

    await expect(
      mailer()!.sendSignInLink("person@example.com", "https://x/y"),
    ).rejects.toMatchObject({ code: "delivery_failed" });
  });

  it("reports the status and not the provider's body", async () => {
    // A provider's error body can quote the request it was sent, which here
    // contains the link. The message carries the status and nothing else.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          "rejected: https://dasher.example.com/sign-in/verify?token=SECRET",
          {
            status: 400,
          },
        ),
      ),
    );

    await expect(
      mailer()!.sendSignInLink(
        "person@example.com",
        "https://dasher.example.com/sign-in/verify?token=SECRET",
      ),
    ).rejects.toThrow(/answered 400$/u);
    await expect(
      mailer()!.sendSignInLink("person@example.com", "https://x/SECRET"),
    ).rejects.not.toThrow(/SECRET/u);
  });
});

describe("the SES transport", () => {
  it("sends the same single-use message through the injected AWS client", async () => {
    const send = vi.fn().mockResolvedValue({ MessageId: "message-1" });
    const transport = sesMailer({ send }, "noreply@luckbutton.com");

    await transport.sendSignInLink(
      "person@example.com",
      "https://luckbutton.com/sign-in/verify?token=abc",
    );

    expect(transport.transport).toBe("ses");
    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0]?.[0] as {
      input: {
        FromEmailAddress: string;
        Destination: { ToAddresses: string[] };
        Content: {
          Simple: {
            Subject: { Data: string };
            Body: { Text: { Data: string } };
          };
        };
      };
    };
    expect(command.input.FromEmailAddress).toBe("noreply@luckbutton.com");
    expect(command.input.Destination.ToAddresses).toEqual([
      "person@example.com",
    ]);
    expect(command.input.Content.Simple.Subject.Data).toBe(
      "Your Dasher sign-in link",
    );
    expect(command.input.Content.Simple.Body.Text.Data).toContain(
      "https://luckbutton.com/sign-in/verify?token=abc",
    );
  });

  it("turns AWS failures into a safe delivery error", async () => {
    const transport = sesMailer(
      { send: vi.fn().mockRejectedValue(new Error("token=SECRET")) },
      "noreply@luckbutton.com",
    );
    const error = await transport
      .sendSignInLink("person@example.com", "https://x/SECRET")
      .catch((one: unknown) => one);
    expect(error).toMatchObject({ code: "delivery_failed" });
    expect(String(error)).not.toContain("SECRET");
    expect(String(error)).not.toContain("person@example.com");
  });
});

describe("the log transport", () => {
  it("writes the link where a developer will see it", () => {
    process.env["DASHER_MAIL_TRANSPORT"] = "log";
    const written: string[] = [];
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        written.push(String(chunk));
        return true;
      });

    try {
      void mailer()!.sendSignInLink("dev@example.com", "https://local/link");
    } finally {
      write.mockRestore();
    }

    expect(written.join("")).toContain("dev@example.com");
    expect(written.join("")).toContain("https://local/link");
  });
});
