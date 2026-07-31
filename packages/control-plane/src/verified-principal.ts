import { normalizeEmailAddress } from "./email.js";

const objectFreeze = Object.freeze;
const reflectApply = Reflect.apply;
const stringCharCodeAt = String.prototype.charCodeAt;

const maximumIdentityScalars = 512;
const maximumIdentityUtf16CodeUnits = maximumIdentityScalars * 2;
const ordinarySpace = 0x20;

export type VerifiedPrincipalErrorCode =
  | "invalid_identity"
  | "invalid_provider_verification"
  | "invalid_verified_email"
  | "unverified_email";

const errorMessages = {
  invalid_identity: "Verified principal identity is invalid",
  invalid_provider_verification: "Provider verification result is invalid",
  invalid_verified_email: "Verified principal email is invalid",
  unverified_email: "Provider result does not contain a verified email",
} as const satisfies Record<VerifiedPrincipalErrorCode, string>;

export class VerifiedPrincipalError extends Error {
  readonly code: VerifiedPrincipalErrorCode;

  constructor(code: VerifiedPrincipalErrorCode) {
    super(errorMessages[code]);
    this.name = "VerifiedPrincipalError";
    this.code = code;
    objectFreeze(this);
  }
}

export interface ServerVerifiedPrincipalInput {
  readonly issuer: string;
  readonly subject: string;
  readonly emailVerified: true;
  readonly verifiedEmail: string;
}

interface PrincipalSnapshot {
  readonly issuer: unknown;
  readonly subject: unknown;
  readonly emailVerified: unknown;
  readonly verifiedEmail: unknown;
}

const constructionAuthority = objectFreeze({});

function reject(code: VerifiedPrincipalErrorCode): never {
  throw new VerifiedPrincipalError(code);
}

function snapshotProviderResult(
  input: ServerVerifiedPrincipalInput,
): PrincipalSnapshot {
  if (input === null || typeof input !== "object") {
    return reject("invalid_provider_verification");
  }

  try {
    return {
      issuer: input.issuer,
      subject: input.subject,
      emailVerified: input.emailVerified,
      verifiedEmail: input.verifiedEmail,
    };
  } catch {
    return reject("invalid_provider_verification");
  }
}

function validateImmutableIdentityText(input: unknown): string {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > maximumIdentityUtf16CodeUnits ||
    reflectApply(stringCharCodeAt, input, [0]) === ordinarySpace ||
    reflectApply(stringCharCodeAt, input, [input.length - 1]) === ordinarySpace
  ) {
    return reject("invalid_identity");
  }

  let scalarCount = 0;
  for (let index = 0; index < input.length; index += 1) {
    const first = reflectApply(stringCharCodeAt, input, [index]);
    if (
      first <= 0x1f ||
      (first >= 0x7f && first <= 0x9f) ||
      (first >= 0xd800 &&
        first <= 0xdfff &&
        !(
          first <= 0xdbff &&
          index + 1 < input.length &&
          reflectApply(stringCharCodeAt, input, [index + 1]) >= 0xdc00 &&
          reflectApply(stringCharCodeAt, input, [index + 1]) <= 0xdfff
        ))
    ) {
      return reject("invalid_identity");
    }

    if (first >= 0xd800 && first <= 0xdbff) {
      index += 1;
    }
    scalarCount += 1;
    if (scalarCount > maximumIdentityScalars) {
      return reject("invalid_identity");
    }
  }

  return input;
}

/**
 * Provider-neutral value produced only after a server adapter has verified an
 * identity-provider assertion. This value validates that adapter result; it
 * does not itself verify an assertion, signature, nonce, audience, or issuer.
 */
export class VerifiedPrincipal {
  readonly #issuer: string;
  readonly #subject: string;
  readonly #normalizedVerifiedEmail: string;

  private constructor(
    authority: object,
    issuer: string,
    subject: string,
    normalizedVerifiedEmail: string,
  ) {
    if (authority !== constructionAuthority) {
      reject("invalid_provider_verification");
    }
    this.#issuer = issuer;
    this.#subject = subject;
    this.#normalizedVerifiedEmail = normalizedVerifiedEmail;
    objectFreeze(this);
  }

  static fromValidatedServerVerification(
    authority: object,
    issuer: string,
    subject: string,
    normalizedVerifiedEmail: string,
  ): VerifiedPrincipal {
    return new VerifiedPrincipal(
      authority,
      issuer,
      subject,
      normalizedVerifiedEmail,
    );
  }

  get issuer(): string {
    return this.#issuer;
  }

  get subject(): string {
    return this.#subject;
  }

  get normalizedVerifiedEmail(): string {
    return this.#normalizedVerifiedEmail;
  }

  get emailVerified(): true {
    return true;
  }
}

const constructVerifiedPrincipal =
  VerifiedPrincipal.fromValidatedServerVerification;
objectFreeze(VerifiedPrincipal.prototype);
objectFreeze(VerifiedPrincipal);

export function createVerifiedPrincipalFromServerVerification(
  input: ServerVerifiedPrincipalInput,
): VerifiedPrincipal {
  const snapshot = snapshotProviderResult(input);
  if (snapshot.emailVerified !== true) {
    return reject("unverified_email");
  }

  const issuer = validateImmutableIdentityText(snapshot.issuer);
  const subject = validateImmutableIdentityText(snapshot.subject);
  let normalizedVerifiedEmail: string;
  try {
    normalizedVerifiedEmail = normalizeEmailAddress(
      snapshot.verifiedEmail as string,
    );
  } catch {
    return reject("invalid_verified_email");
  }

  return reflectApply(constructVerifiedPrincipal, VerifiedPrincipal, [
    constructionAuthority,
    issuer,
    subject,
    normalizedVerifiedEmail,
  ]);
}
