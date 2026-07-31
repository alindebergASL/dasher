import { describe, expect, it } from "vitest";

import {
  VerifiedPrincipal,
  VerifiedPrincipalError,
  createVerifiedPrincipalFromServerVerification,
} from "./verified-principal.js";

function captureError(input: unknown): VerifiedPrincipalError {
  try {
    createVerifiedPrincipalFromServerVerification(input as never);
  } catch (error) {
    expect(error).toBeInstanceOf(VerifiedPrincipalError);
    return error as VerifiedPrincipalError;
  }
  throw new Error("expected principal construction to fail");
}

describe("verified provider principal boundary", () => {
  it("creates a frozen provider-neutral value only from a verified result", () => {
    const input = {
      issuer: "https://identity.example/tenant",
      subject: "Provider-Subject-123",
      emailVerified: true as const,
      verifiedEmail: "Person+Pilot@Example.TEST",
      ignoredAssertion: "raw-assertion-marker",
    };
    const principal = createVerifiedPrincipalFromServerVerification(input);

    expect(principal).toBeInstanceOf(VerifiedPrincipal);
    expect(principal).toMatchObject({
      issuer: "https://identity.example/tenant",
      subject: "Provider-Subject-123",
      normalizedVerifiedEmail: "person+pilot@example.test",
      emailVerified: true,
    });
    expect(Object.isFrozen(principal)).toBe(true);
    expect(Reflect.ownKeys(principal)).toEqual([]);
    expect(JSON.stringify(principal)).toBe("{}");
    expect(JSON.stringify(principal)).not.toContain("raw-assertion-marker");
  });

  it("snapshots hostile provider result getters once and retains no input object", () => {
    const reads: string[] = [];
    const input = {
      get issuer() {
        reads.push("issuer");
        return "issuer";
      },
      get subject() {
        reads.push("subject");
        return "subject";
      },
      get emailVerified() {
        reads.push("emailVerified");
        return true as const;
      },
      get verifiedEmail() {
        reads.push("verifiedEmail");
        return "USER@EXAMPLE.TEST";
      },
    };
    const principal = createVerifiedPrincipalFromServerVerification(input);

    expect(reads).toEqual([
      "issuer",
      "subject",
      "emailVerified",
      "verifiedEmail",
    ]);
    expect(principal.normalizedVerifiedEmail).toBe("user@example.test");
  });

  it.each([
    ["leading ordinary space", " issuer"],
    ["trailing ordinary space", "issuer "],
    ["ASCII control", "issuer\nvalue"],
    ["DEL", "issuer\u007fvalue"],
    ["C1 control", "issuer\u0085value"],
    ["unpaired high surrogate", "issuer\ud800"],
    ["unpaired low surrogate", "issuer\udc00"],
    ["empty", ""],
    ["513 scalars", "x".repeat(513)],
    ["early UTF-16 bound", "😀".repeat(513)],
  ])("rejects %s identity text", (_name, issuer) => {
    expect(
      captureError({
        issuer,
        subject: "subject",
        emailVerified: true,
        verifiedEmail: "user@example.test",
      }).code,
    ).toBe("invalid_identity");
  });

  it("accepts exactly 512 Unicode scalar values without altering identity", () => {
    const issuer = "😀".repeat(512);
    const principal = createVerifiedPrincipalFromServerVerification({
      issuer,
      subject: "subject",
      emailVerified: true,
      verifiedEmail: "user@example.test",
    });
    expect(principal.issuer).toBe(issuer);
  });

  it("rejects false or truthy lookalike verification and invalid email", () => {
    for (const emailVerified of [false, 1, "true", new Boolean(true)]) {
      expect(
        captureError({
          issuer: "issuer",
          subject: "subject",
          emailVerified,
          verifiedEmail: "user@example.test",
        }).code,
      ).toBe("unverified_email");
    }
    expect(
      captureError({
        issuer: "issuer",
        subject: "subject",
        emailVerified: true,
        verifiedEmail: " user@example.test",
      }).code,
    ).toBe("invalid_verified_email");
  });

  it("normalizes hostile getters and proxy faults to bounded secret-free errors", () => {
    const marker = "raw-principal-marker";
    const error = captureError(
      new Proxy(
        {},
        {
          get() {
            throw new Error(marker);
          },
        },
      ),
    );
    const rendered = [
      error.name,
      error.code,
      error.message,
      String(error),
      JSON.stringify(error),
    ].join("\n");

    expect(error.code).toBe("invalid_provider_verification");
    expect(Object.isFrozen(error)).toBe(true);
    expect(error.message.length).toBeLessThanOrEqual(64);
    expect(rendered).not.toContain(marker);
    expect(Reflect.ownKeys(error)).not.toContain("cause");
  });

  it("cannot be directly constructed without the private trust authority", () => {
    expect(() =>
      Reflect.construct(VerifiedPrincipal, [
        {},
        "issuer",
        "subject",
        "user@example.test",
      ]),
    ).toThrowError(VerifiedPrincipalError);
  });

  it("freezes the value prototype against post-construction getter mutation", () => {
    const principal = createVerifiedPrincipalFromServerVerification({
      issuer: "immutable-issuer",
      subject: "immutable-subject",
      emailVerified: true,
      verifiedEmail: "USER@EXAMPLE.TEST",
    });

    expect(Object.isFrozen(VerifiedPrincipal.prototype)).toBe(true);
    expect(Object.isFrozen(VerifiedPrincipal)).toBe(true);
    expect(() =>
      Object.defineProperty(VerifiedPrincipal.prototype, "issuer", {
        get() {
          return "mutated";
        },
      }),
    ).toThrow(TypeError);
    expect(principal).toMatchObject({
      issuer: "immutable-issuer",
      subject: "immutable-subject",
      normalizedVerifiedEmail: "user@example.test",
    });
  });
});
