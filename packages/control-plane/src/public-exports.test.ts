import { describe, expect, it } from "vitest";

import * as packageRoot from "@dasher/control-plane";
import * as emailExports from "@dasher/control-plane/email";
import * as secretExports from "@dasher/control-plane/secrets";
import * as sessionCookieExports from "@dasher/control-plane/session-cookie";

describe("control-plane Task 5 public exports", () => {
  it("exposes the expected root symbols", () => {
    expect(packageRoot).toMatchObject({
      EmailNormalizationError: expect.any(Function),
      SecretKeyRing: expect.any(Function),
      SecretPrimitiveError: expect.any(Function),
      SessionCookieMetadataError: expect.any(Function),
      constantTimeDigestEqual: expect.any(Function),
      createSessionCookieMetadata: expect.any(Function),
      normalizeEmailAddress: expect.any(Function),
    });
  });

  it("exposes only the expected email runtime symbols", () => {
    expect(Object.keys(emailExports).sort()).toEqual([
      "EmailNormalizationError",
      "normalizeEmailAddress",
    ]);
  });

  it("exposes only the expected secret runtime symbols", () => {
    expect(Object.keys(secretExports).sort()).toEqual([
      "SecretKeyRing",
      "SecretPrimitiveError",
      "constantTimeDigestEqual",
    ]);
  });

  it("exposes only the expected session-cookie runtime symbols", () => {
    expect(Object.keys(sessionCookieExports).sort()).toEqual([
      "SessionCookieMetadataError",
      "createSessionCookieMetadata",
    ]);
  });
});
