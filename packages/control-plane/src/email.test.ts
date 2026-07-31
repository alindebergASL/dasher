import { describe, expect, it } from "vitest";

import { EmailNormalizationError, normalizeEmailAddress } from "./email.js";

function captureError(input: string): EmailNormalizationError {
  try {
    normalizeEmailAddress(input);
  } catch (error) {
    expect(error).toBeInstanceOf(EmailNormalizationError);
    return error as EmailNormalizationError;
  }

  throw new Error("expected email normalization to fail");
}

function lowercaseAscii(character: string): string {
  const code = character.charCodeAt(0);
  return String.fromCharCode(code >= 0x41 && code <= 0x5a ? code + 0x20 : code);
}

describe("normalizeEmailAddress", () => {
  it("exhaustively handles every ASCII byte in a local-part position", () => {
    for (let code = 0; code <= 0x7f; code += 1) {
      const character = String.fromCharCode(code);
      const input = `a${character}@b`;
      const allowed = code >= 0x21 && code <= 0x7e && code !== 0x40;

      if (allowed) {
        expect(
          normalizeEmailAddress(input),
          `ASCII 0x${code.toString(16)}`,
        ).toBe(`a${lowercaseAscii(character)}@b`);
      } else {
        expect(
          () => normalizeEmailAddress(input),
          `ASCII 0x${code.toString(16)}`,
        ).toThrow(EmailNormalizationError);
      }
    }
  });

  it("exhaustively handles every ASCII byte in a domain position", () => {
    for (let code = 0; code <= 0x7f; code += 1) {
      const character = String.fromCharCode(code);
      const input = `a@b${character}`;
      const allowed = code >= 0x21 && code <= 0x7e && code !== 0x40;

      if (allowed) {
        expect(
          normalizeEmailAddress(input),
          `ASCII 0x${code.toString(16)}`,
        ).toBe(`a@b${lowercaseAscii(character)}`);
      } else {
        expect(
          () => normalizeEmailAddress(input),
          `ASCII 0x${code.toString(16)}`,
        ).toThrow(EmailNormalizationError);
      }
    }
  });

  it("maps only ASCII uppercase in both components", () => {
    expect(normalizeEmailAddress("AZaz@EXAMPLE.Test")).toBe(
      "azaz@example.test",
    );
  });

  it("preserves every allowed non-uppercase punctuation byte", () => {
    const punctuation = Array.from({ length: 0x7e - 0x21 + 1 }, (_, index) =>
      String.fromCharCode(index + 0x21),
    )
      .filter((character) => character !== "@" && !/[A-Z]/u.test(character))
      .join("");

    expect(normalizeEmailAddress(`${punctuation}@${punctuation}`)).toBe(
      `${punctuation}@${punctuation}`,
    );
  });

  it.each(["abc", "@abc", "abc@", "a@@b", "a@b@c"])(
    "rejects malformed separator input %j",
    (input) => {
      expect(captureError(input).code).toBe("invalid_separator");
    },
  );

  it.each(["é", "İ", "ı", "ß", "K", "Ａ", "😀", "e\u0301"])(
    "rejects representative non-ASCII input containing %s",
    (character) => {
      expect(captureError(`a${character}@b`).code).toBe("invalid_character");
      expect(captureError(`a@b${character}`).code).toBe("invalid_character");
    },
  );

  it("enforces exact total-length boundaries", () => {
    for (const length of [0, 1, 2]) {
      expect(captureError("a".repeat(length)).code).toBe("invalid_length");
    }

    for (const length of [3, 319, 320]) {
      const input = `${"A".repeat(length - 2)}@B`;
      expect(input).toHaveLength(length);
      expect(normalizeEmailAddress(input)).toBe(`${"a".repeat(length - 2)}@b`);
    }

    expect(captureError(`${"a".repeat(319)}@b`).code).toBe("invalid_length");
  });

  it("rejects NUL at the application boundary without trimming", () => {
    expect(captureError("a\u0000@b").code).toBe("invalid_character");
    expect(captureError("a@b\u0000").code).toBe("invalid_character");
    expect(captureError(" a@b").code).toBe("invalid_character");
    expect(captureError("a@b ").code).toBe("invalid_character");
  });

  it("uses typed bounded errors without retaining the input", () => {
    const marker = "MARKER@EXAMPLE.TEST\u0000";
    const error = captureError(marker);
    const rendered = [
      error.name,
      error.code,
      error.message,
      String(error),
      JSON.stringify(error),
    ].join("\n");

    expect(error.message.length).toBeLessThanOrEqual(64);
    expect(rendered).not.toContain(marker);
    expect(Reflect.ownKeys(error)).not.toContain("input");
  });

  it("rejects non-string runtime input", () => {
    expect(() => normalizeEmailAddress(null as unknown as string)).toThrowError(
      expect.objectContaining({
        code: "invalid_type",
      }),
    );
  });
});
