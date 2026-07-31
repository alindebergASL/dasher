const sessionCookieName = "__Host-dasher_session" as const;

export type SessionCookieMetadataErrorCode =
  "invalid_timestamp" | "nonfuture_expiry";

const errorMessages = {
  invalid_timestamp: "Session cookie timestamp is invalid",
  nonfuture_expiry: "Session cookie expiry must be in the future",
} as const satisfies Record<SessionCookieMetadataErrorCode, string>;

export class SessionCookieMetadataError extends Error {
  readonly code: SessionCookieMetadataErrorCode;

  constructor(code: SessionCookieMetadataErrorCode) {
    super(errorMessages[code]);
    this.name = "SessionCookieMetadataError";
    this.code = code;
  }
}

export interface SessionCookieMetadata {
  readonly name: typeof sessionCookieName;
  readonly secure: true;
  readonly httpOnly: true;
  readonly path: "/";
  readonly sameSite: "lax";
  readonly maxAge: number;
}

function reject(code: SessionCookieMetadataErrorCode): never {
  throw new SessionCookieMetadataError(code);
}

export function createSessionCookieMetadata(
  currentEpochMilliseconds: number,
  absoluteExpiryEpochMilliseconds: number,
): SessionCookieMetadata {
  if (
    !Number.isSafeInteger(currentEpochMilliseconds) ||
    !Number.isSafeInteger(absoluteExpiryEpochMilliseconds)
  ) {
    return reject("invalid_timestamp");
  }
  if (absoluteExpiryEpochMilliseconds <= currentEpochMilliseconds) {
    return reject("nonfuture_expiry");
  }

  const durationMilliseconds =
    BigInt(absoluteExpiryEpochMilliseconds) - BigInt(currentEpochMilliseconds);
  const maxAge = durationMilliseconds / 1_000n;

  return Object.freeze({
    name: sessionCookieName,
    secure: true,
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    maxAge: Number(maxAge),
  });
}
