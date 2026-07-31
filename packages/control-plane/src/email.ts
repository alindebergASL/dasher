export type EmailNormalizationErrorCode =
  "invalid_character" | "invalid_length" | "invalid_separator" | "invalid_type";

const errorMessages = {
  invalid_character: "Email address contains a disallowed character",
  invalid_length: "Email address length is outside the allowed range",
  invalid_separator: "Email address must contain one internal separator",
  invalid_type: "Email address must be a string",
} as const satisfies Record<EmailNormalizationErrorCode, string>;

export class EmailNormalizationError extends Error {
  readonly code: EmailNormalizationErrorCode;

  constructor(code: EmailNormalizationErrorCode) {
    super(errorMessages[code]);
    this.name = "EmailNormalizationError";
    this.code = code;
  }
}

function reject(code: EmailNormalizationErrorCode): never {
  throw new EmailNormalizationError(code);
}

export function normalizeEmailAddress(input: string): string {
  if (typeof input !== "string") {
    return reject("invalid_type");
  }
  if (input.length < 3 || input.length > 320) {
    return reject("invalid_length");
  }

  let separatorIndex = -1;
  let normalized = "";

  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    if (code < 0x21 || code > 0x7e) {
      return reject("invalid_character");
    }

    if (code === 0x40) {
      if (separatorIndex !== -1) {
        return reject("invalid_separator");
      }
      separatorIndex = index;
    }

    normalized += String.fromCharCode(
      code >= 0x41 && code <= 0x5a ? code + 0x20 : code,
    );
  }

  if (separatorIndex <= 0 || separatorIndex === input.length - 1) {
    return reject("invalid_separator");
  }

  return normalized;
}
