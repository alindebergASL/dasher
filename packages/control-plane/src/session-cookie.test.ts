import { describe, expect, it } from "vitest";

import {
  SessionCookieMetadataError,
  createSessionCookieMetadata,
  type SessionCookieMetadata,
} from "./session-cookie.js";

type Assert<Type extends true> = Type;
type MetadataHasNoDomain = Assert<
  "domain" extends keyof SessionCookieMetadata ? false : true
>;
const metadataHasNoDomain: MetadataHasNoDomain = true;

function captureError(
  currentEpochMilliseconds: number,
  absoluteExpiryEpochMilliseconds: number,
): SessionCookieMetadataError {
  try {
    createSessionCookieMetadata(
      currentEpochMilliseconds,
      absoluteExpiryEpochMilliseconds,
    );
  } catch (error) {
    expect(error).toBeInstanceOf(SessionCookieMetadataError);
    return error as SessionCookieMetadataError;
  }

  throw new Error("expected cookie metadata creation to fail");
}

describe("createSessionCookieMetadata", () => {
  it("returns the exact host-only session cookie invariants", () => {
    const metadata = createSessionCookieMetadata(1_000, 61_000);

    expect(metadataHasNoDomain).toBe(true);
    expect(metadata).toEqual({
      name: "__Host-dasher_session",
      secure: true,
      httpOnly: true,
      path: "/",
      sameSite: "lax",
      maxAge: 60,
    });
    expect(Object.hasOwn(metadata, "domain")).toBe(false);
    expect("domain" in metadata).toBe(false);
  });

  it("is defensively immutable", () => {
    const metadata = createSessionCookieMetadata(1_000, 2_000);

    expect(Object.isFrozen(metadata)).toBe(true);
    expect(() => {
      (metadata as { maxAge: number }).maxAge = 99;
    }).toThrow(TypeError);
    expect(metadata.maxAge).toBe(1);
  });

  it.each([
    [10_001, 0],
    [10_999, 0],
    [11_000, 1],
    [11_001, 1],
    [11_999, 1],
    [12_000, 2],
  ])(
    "floors expiry %i without extending beyond it",
    (expiry, expectedMaxAge) => {
      const current = 10_000;
      const metadata = createSessionCookieMetadata(current, expiry);
      const representedMilliseconds = metadata.maxAge * 1_000;

      expect(metadata.maxAge).toBe(expectedMaxAge);
      expect(Number.isInteger(metadata.maxAge)).toBe(true);
      expect(representedMilliseconds).toBeLessThanOrEqual(expiry - current);
      expect(representedMilliseconds + 1_000).toBeGreaterThan(expiry - current);
    },
  );

  it("derives varying lifetimes only from the supplied timestamps", () => {
    expect(createSessionCookieMetadata(500, 5_500).maxAge).toBe(5);
    expect(createSessionCookieMetadata(500, 86_400_499).maxAge).toBe(86_399);
  });

  it("rejects every non-finite, non-safe, or non-integer timestamp", () => {
    const invalidTimestamps = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
      Number.MIN_SAFE_INTEGER - 1,
    ];

    for (const invalid of invalidTimestamps) {
      expect(captureError(invalid, 10_000).code).toBe("invalid_timestamp");
      expect(captureError(0, invalid).code).toBe("invalid_timestamp");
    }
  });

  it("rejects equal or past absolute expiry", () => {
    expect(captureError(10_000, 10_000).code).toBe("nonfuture_expiry");
    expect(captureError(10_000, 9_999).code).toBe("nonfuture_expiry");
  });

  it("uses typed bounded errors without retaining timestamps", () => {
    const error = captureError(12_345_678, 12_345_678);
    const rendered = [
      error.name,
      error.code,
      error.message,
      String(error),
      JSON.stringify(error),
    ].join("\n");

    expect(error.message.length).toBeLessThanOrEqual(64);
    expect(rendered).not.toContain("12345678");
    expect(Reflect.ownKeys(error)).not.toContain("currentEpochMilliseconds");
    expect(Reflect.ownKeys(error)).not.toContain(
      "absoluteExpiryEpochMilliseconds",
    );
  });
});
