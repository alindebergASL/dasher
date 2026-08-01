import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const createHmacCapability = createHmac;
const randomBytesCapability = randomBytes;
const timingSafeEqualCapability = timingSafeEqual;
const arrayIsArray = Array.isArray;
const arrayConstructor = Array;
const bufferConstructor = Buffer;
const bufferFrom = Buffer.from;
const bufferToString = Buffer.prototype.toString;
const functionHasInstance = Function.prototype[Symbol.hasInstance];
const mapConstructor = Map;
const mapGet = Map.prototype.get;
const mapHas = Map.prototype.has;
const mapSet = Map.prototype.set;
const numberConstructor = Number;
const numberIsInteger = Number.isInteger;
const numberIsSafeInteger = Number.isSafeInteger;
const objectFreeze = Object.freeze;
const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const objectGetPrototypeOf = Object.getPrototypeOf;
const reflectApply = Reflect.apply;
const regexpTest = RegExp.prototype.test;
const setAdd = Set.prototype.add;
const setConstructor = Set;
const setHas = Set.prototype.has;
const stringSplit = String.prototype.split;
const stringConstructor = String;
const uint8ArrayConstructor = Uint8Array;
const uint8ArraySet = Uint8Array.prototype.set;

const secretByteLength = 32;
const digestByteLength = 32;
const maximumVerificationVersions = 3;
const maximumRetiredVersions = 32_767;
const maximumVersion = 32_767;
const minimumWireValueLength = 48;
const maximumWireValueLength = 52;
const versionPattern = /^[1-9][0-9]{0,4}$/;
const encodedSecretPattern = /^[A-Za-z0-9_-]{43}$/;
const hmacFrameSeparator = new uint8ArrayConstructor(1);
const typedArrayPrototype = objectGetPrototypeOf(
  uint8ArrayConstructor.prototype,
) as object;
const typedArrayByteLengthGetter = objectGetOwnPropertyDescriptor(
  typedArrayPrototype,
  "byteLength",
)!.get!;
const hmacMethodProbe = createHmacCapability("sha256", hmacFrameSeparator);
const hmacUpdate = hmacMethodProbe.update;
const hmacDigest = hmacMethodProbe.digest;
reflectApply(hmacDigest, hmacMethodProbe, []);

export type SecretKind = "invite" | "session" | "csrf";

export type SecretPrimitiveErrorCode =
  | "current_version_missing"
  | "duplicate_version"
  | "invalid_configuration"
  | "invalid_key"
  | "invalid_kind"
  | "invalid_random_bytes"
  | "invalid_token"
  | "invalid_version"
  | "oversized_key_ring"
  | "oversized_retired_versions"
  | "retired_version"
  | "retired_version_overlap"
  | "unknown_version"
  | "wrong_token_kind";

const errorMessages = {
  current_version_missing: "Secret key ring current version is not active",
  duplicate_version: "Secret key ring contains a duplicate version",
  invalid_configuration: "Secret key ring configuration is invalid",
  invalid_key: "Secret key material must contain exactly 32 bytes",
  invalid_kind: "Secret kind is invalid",
  invalid_random_bytes: "Secret random source returned invalid bytes",
  invalid_token: "Secret token is malformed",
  invalid_version: "Secret key version is invalid",
  oversized_key_ring: "Secret key ring has too many active versions",
  oversized_retired_versions: "Secret key ring has too many retired versions",
  retired_version: "Secret token uses a retired key version",
  retired_version_overlap: "Secret key version is both active and retired",
  unknown_version: "Secret token uses an unknown key version",
  wrong_token_kind: "Secret token has the wrong kind",
} as const satisfies Record<SecretPrimitiveErrorCode, string>;

export class SecretPrimitiveError extends Error {
  readonly code: SecretPrimitiveErrorCode;

  constructor(code: SecretPrimitiveErrorCode) {
    super(errorMessages[code]);
    this.name = "SecretPrimitiveError";
    this.code = code;
    objectFreeze(this);
  }
}

interface SecretVerificationKey {
  readonly version: number;
  readonly key: Uint8Array;
}

export interface SecretKeyRingConfig {
  readonly currentVersion: number;
  readonly verificationKeys: readonly SecretVerificationKey[];
  readonly retiredVersions?: readonly number[];
}

type RandomByteSource = (byteLength: number) => Uint8Array;

interface SecretKeyRingOptions {
  readonly randomBytes?: RandomByteSource;
}

export interface SecretPersistenceMaterial {
  readonly keyVersion: number;
  readonly digest: Uint8Array;
}

type SecretWireValue<Kind extends SecretKind> = Kind extends "invite"
  ? `i1.${number}.${string}`
  : Kind extends "session"
    ? `s1.${number}.${string}`
    : `c1.${number}.${string}`;

export interface IssuedSecret<Kind extends SecretKind = SecretKind> {
  readonly wireValue: SecretWireValue<Kind>;
  readonly persistence: SecretPersistenceMaterial;
}

interface SecretKindMetadata {
  readonly prefix: "i1" | "s1" | "c1";
  readonly domainLabel:
    "dasher:invite:v1" | "dasher:session:v1" | "dasher:csrf:v1";
}

interface ConfigurationSnapshot {
  readonly currentVersion: unknown;
  readonly verificationKeys: unknown;
  readonly retiredVersions: unknown;
  readonly randomByteSource: unknown;
}

interface VerificationKeyPropertySnapshot {
  readonly version: unknown;
  readonly key: unknown;
}

const kindMetadata = objectFreeze({
  invite: objectFreeze({
    prefix: "i1",
    domainLabel: "dasher:invite:v1",
  }),
  session: objectFreeze({
    prefix: "s1",
    domainLabel: "dasher:session:v1",
  }),
  csrf: objectFreeze({
    prefix: "c1",
    domainLabel: "dasher:csrf:v1",
  }),
} satisfies Record<SecretKind, SecretKindMetadata>);

function reject(code: SecretPrimitiveErrorCode): never {
  throw new SecretPrimitiveError(code);
}

function isCanonicalVersion(version: unknown): version is number {
  return (
    typeof version === "number" &&
    numberIsInteger(version) &&
    version >= 1 &&
    version <= maximumVersion
  );
}

function parseVersion(encodedVersion: string): number {
  if (!reflectApply(regexpTest, versionPattern, [encodedVersion])) {
    return reject("invalid_version");
  }

  const version = reflectApply(numberConstructor, undefined, [encodedVersion]);
  if (!isCanonicalVersion(version)) {
    return reject("invalid_version");
  }

  return version;
}

function metadataFor(kind: SecretKind): SecretKindMetadata {
  switch (kind) {
    case "invite":
      return kindMetadata.invite;
    case "session":
      return kindMetadata.session;
    case "csrf":
      return kindMetadata.csrf;
    default:
      return reject("invalid_kind");
  }
}

function snapshotConfiguration(
  config: SecretKeyRingConfig,
  options: SecretKeyRingOptions,
): ConfigurationSnapshot {
  if (
    config === null ||
    typeof config !== "object" ||
    options === null ||
    typeof options !== "object"
  ) {
    return reject("invalid_configuration");
  }

  try {
    return {
      currentVersion: config.currentVersion,
      verificationKeys: config.verificationKeys,
      retiredVersions: config.retiredVersions,
      randomByteSource: options.randomBytes,
    };
  } catch {
    return reject("invalid_configuration");
  }
}

function snapshotIndexedArray(
  candidate: unknown,
  minimumLength: number,
  maximumLength: number,
  boundsError: SecretPrimitiveErrorCode,
): readonly unknown[] {
  let length: number;
  try {
    if (!arrayIsArray(candidate)) {
      return reject("invalid_configuration");
    }
    length = candidate.length;
  } catch {
    return reject("invalid_configuration");
  }

  if (!numberIsSafeInteger(length) || length < 0) {
    return reject("invalid_configuration");
  }
  if (length < minimumLength || length > maximumLength) {
    return reject(boundsError);
  }

  const snapshot = new arrayConstructor<unknown>(length);
  try {
    for (let index = 0; index < length; index += 1) {
      snapshot[index] = candidate[index];
    }
  } catch {
    return reject("invalid_configuration");
  }

  return snapshot;
}

function snapshotVerificationKeyProperties(
  candidate: unknown,
): VerificationKeyPropertySnapshot {
  if (candidate === null || typeof candidate !== "object") {
    return reject("invalid_version");
  }

  try {
    const entry = candidate as Partial<SecretVerificationKey>;
    return {
      version: entry.version,
      key: entry.key,
    };
  } catch {
    return reject("invalid_configuration");
  }
}

function copyExactBytes(candidate: unknown): Uint8Array | undefined {
  if (
    !reflectApply(functionHasInstance, uint8ArrayConstructor, [candidate]) ||
    reflectApply(typedArrayByteLengthGetter, candidate, []) !== secretByteLength
  ) {
    return undefined;
  }

  const snapshot = new uint8ArrayConstructor(secretByteLength);
  reflectApply(uint8ArraySet, snapshot, [candidate]);
  return snapshot;
}

function copyTrustedDigest(candidate: Uint8Array): Uint8Array {
  const snapshot = new uint8ArrayConstructor(digestByteLength);
  reflectApply(uint8ArraySet, snapshot, [candidate]);
  return snapshot;
}

function snapshotKeyBytes(candidate: unknown): Uint8Array {
  try {
    const snapshot = copyExactBytes(candidate);
    if (snapshot === undefined) {
      return reject("invalid_key");
    }
    return snapshot;
  } catch {
    return reject("invalid_key");
  }
}

function generateSecret(randomByteSource: RandomByteSource): Uint8Array {
  try {
    const snapshot = copyExactBytes(randomByteSource(secretByteLength));
    if (snapshot === undefined) {
      return reject("invalid_random_bytes");
    }
    return snapshot;
  } catch {
    return reject("invalid_random_bytes");
  }
}

function encodeSecret(secret: Uint8Array): string {
  const buffer = reflectApply(bufferFrom, bufferConstructor, [secret]);
  return reflectApply(bufferToString, buffer, ["base64url"]);
}

function decodeSecret(encodedSecret: string): Uint8Array {
  if (!reflectApply(regexpTest, encodedSecretPattern, [encodedSecret])) {
    return reject("invalid_token");
  }

  const decoded = reflectApply(bufferFrom, bufferConstructor, [
    encodedSecret,
    "base64url",
  ]);
  if (
    reflectApply(typedArrayByteLengthGetter, decoded, []) !==
      secretByteLength ||
    encodeSecret(decoded) !== encodedSecret
  ) {
    return reject("invalid_token");
  }

  return copyTrustedDigest(decoded);
}

function digestSecret(
  key: Uint8Array,
  domainLabel: SecretKindMetadata["domainLabel"],
  secret: Uint8Array,
): Uint8Array {
  const hmac = createHmacCapability("sha256", key);
  reflectApply(hmacUpdate, hmac, [domainLabel, "ascii"]);
  reflectApply(hmacUpdate, hmac, [hmacFrameSeparator]);
  reflectApply(hmacUpdate, hmac, [secret]);
  const digest = reflectApply(hmacDigest, hmac, []);

  return copyTrustedDigest(digest);
}

function persistenceMaterial(
  keyVersion: number,
  digest: Uint8Array,
): SecretPersistenceMaterial {
  return objectFreeze({
    keyVersion,
    digest: copyTrustedDigest(digest),
  });
}

function parseToken(
  kind: SecretKind,
  wireValue: string,
): { readonly version: number; readonly secret: Uint8Array } {
  if (
    typeof wireValue !== "string" ||
    wireValue.length < minimumWireValueLength ||
    wireValue.length > maximumWireValueLength
  ) {
    return reject("invalid_token");
  }

  const metadata = metadataFor(kind);
  const segments = reflectApply(stringSplit, wireValue, ["."]);
  if (segments.length !== 3) {
    return reject("invalid_token");
  }

  const prefix = segments[0]!;
  if (prefix !== metadata.prefix) {
    return reject(
      prefix === "i1" || prefix === "s1" || prefix === "c1"
        ? "wrong_token_kind"
        : "invalid_token",
    );
  }

  return {
    version: parseVersion(segments[1]!),
    secret: decodeSecret(segments[2]!),
  };
}

export function constantTimeDigestEqual(
  left: Uint8Array,
  right: Uint8Array,
): boolean {
  try {
    if (
      !reflectApply(functionHasInstance, uint8ArrayConstructor, [left]) ||
      !reflectApply(functionHasInstance, uint8ArrayConstructor, [right]) ||
      reflectApply(typedArrayByteLengthGetter, left, []) !== digestByteLength ||
      reflectApply(typedArrayByteLengthGetter, right, []) !== digestByteLength
    ) {
      return false;
    }

    return timingSafeEqualCapability(left, right);
  } catch {
    return false;
  }
}

export class SecretKeyRing {
  readonly #currentVersion: number;
  readonly #verificationKeys: ReadonlyMap<number, Uint8Array>;
  readonly #retiredVersions: ReadonlySet<number>;
  readonly #randomByteSource: RandomByteSource;

  constructor(config: SecretKeyRingConfig, options: SecretKeyRingOptions = {}) {
    const configuration = snapshotConfiguration(config, options);
    if (!isCanonicalVersion(configuration.currentVersion)) {
      reject("invalid_version");
    }
    if (
      configuration.randomByteSource !== undefined &&
      typeof configuration.randomByteSource !== "function"
    ) {
      reject("invalid_configuration");
    }

    const verificationKeyEntries = snapshotIndexedArray(
      configuration.verificationKeys,
      1,
      maximumVerificationVersions,
      "oversized_key_ring",
    );
    const retiredVersionEntries =
      configuration.retiredVersions === undefined
        ? []
        : snapshotIndexedArray(
            configuration.retiredVersions,
            0,
            maximumRetiredVersions,
            "oversized_retired_versions",
          );

    const verificationKeys = new mapConstructor<number, Uint8Array>();
    for (let index = 0; index < verificationKeyEntries.length; index += 1) {
      const candidate = verificationKeyEntries[index];
      const entry = snapshotVerificationKeyProperties(candidate);
      if (!isCanonicalVersion(entry.version)) {
        reject("invalid_version");
      }
      if (reflectApply(mapHas, verificationKeys, [entry.version])) {
        reject("duplicate_version");
      }

      reflectApply(mapSet, verificationKeys, [
        entry.version,
        snapshotKeyBytes(entry.key),
      ]);
    }

    if (
      !reflectApply(mapHas, verificationKeys, [configuration.currentVersion])
    ) {
      reject("current_version_missing");
    }

    const retiredVersionSet = new setConstructor<number>();
    for (let index = 0; index < retiredVersionEntries.length; index += 1) {
      const version = retiredVersionEntries[index];
      if (!isCanonicalVersion(version)) {
        reject("invalid_version");
      }
      if (reflectApply(setHas, retiredVersionSet, [version])) {
        reject("duplicate_version");
      }
      if (reflectApply(mapHas, verificationKeys, [version])) {
        reject("retired_version_overlap");
      }

      reflectApply(setAdd, retiredVersionSet, [version]);
    }

    this.#currentVersion = configuration.currentVersion;
    this.#verificationKeys = verificationKeys;
    this.#retiredVersions = retiredVersionSet;
    this.#randomByteSource =
      (configuration.randomByteSource as RandomByteSource | undefined) ??
      randomBytesCapability;
  }

  issue<Kind extends SecretKind>(kind: Kind): IssuedSecret<Kind> {
    const metadata = metadataFor(kind);
    const secret = generateSecret(this.#randomByteSource);
    const key = reflectApply(mapGet, this.#verificationKeys, [
      this.#currentVersion,
    ]);
    if (key === undefined) {
      return reject("current_version_missing");
    }

    const encodedSecret = encodeSecret(secret);
    const wireValue =
      `${metadata.prefix}.${reflectApply(stringConstructor, undefined, [this.#currentVersion])}.${encodedSecret}` as SecretWireValue<Kind>;

    return objectFreeze({
      wireValue,
      persistence: persistenceMaterial(
        this.#currentVersion,
        digestSecret(key, metadata.domainLabel, secret),
      ),
    });
  }

  verify(kind: SecretKind, wireValue: string): SecretPersistenceMaterial {
    const metadata = metadataFor(kind);
    const parsed = parseToken(kind, wireValue);
    const key = reflectApply(mapGet, this.#verificationKeys, [parsed.version]);

    if (key === undefined) {
      if (reflectApply(setHas, this.#retiredVersions, [parsed.version])) {
        return reject("retired_version");
      }
      return reject("unknown_version");
    }

    return persistenceMaterial(
      parsed.version,
      digestSecret(key, metadata.domainLabel, parsed.secret),
    );
  }
}
