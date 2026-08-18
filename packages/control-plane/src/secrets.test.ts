import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";

import { describe, expect, it } from "vitest";

import {
  SecretKeyRing,
  SecretPrimitiveError,
  constantTimeDigestEqual,
  type SecretKeyRingConfig,
  type SecretKind,
  type SecretPersistenceMaterial,
} from "./secrets";

const intrinsicDefineProperty = Object.defineProperty;
const intrinsicGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const intrinsicReflectDeleteProperty = Reflect.deleteProperty;

const vectorKey = Uint8Array.from({ length: 32 }, (_, index) => index);
const vectorSecret = Uint8Array.from(
  { length: 32 },
  (_, index) => index + 0x20,
);
const vectorSecretEncoded = "ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8";

type Assert<Type extends true> = Type;
type PersistenceHasNoPlaintext = Assert<
  Extract<keyof SecretPersistenceMaterial, "secret" | "wireValue"> extends never
    ? true
    : false
>;
const persistenceHasNoPlaintext: PersistenceHasNoPlaintext = true;

function bytes(seed: number): Uint8Array {
  return Uint8Array.from({ length: 32 }, (_, index) => (seed + index) & 0xff);
}

function fixedRandom(source: Uint8Array = vectorSecret) {
  return (byteLength: number): Uint8Array => {
    expect(byteLength).toBe(32);
    return source;
  };
}

function ring(
  config: Partial<SecretKeyRingConfig> = {},
  randomSource = fixedRandom(),
): SecretKeyRing {
  return new SecretKeyRing(
    {
      currentVersion: 2,
      verificationKeys: [
        { version: 1, key: bytes(0x40) },
        { version: 2, key: vectorKey },
      ],
      retiredVersions: [3],
      ...config,
    },
    { randomBytes: randomSource },
  );
}

function captureError(action: () => unknown): SecretPrimitiveError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(SecretPrimitiveError);
    return error as SecretPrimitiveError;
  }

  throw new Error("expected secret primitive operation to fail");
}

function hex(value: Uint8Array): string {
  return Buffer.from(value).toString("hex");
}

describe("SecretKeyRing deterministic cryptography", () => {
  it("retains module-snapshotted node:crypto capabilities and Hmac methods", () => {
    const marker = "mutable-node-crypto-diagnostic-marker";
    const mutableCrypto = crypto as typeof crypto;
    const originalCreateHmac = mutableCrypto.createHmac;
    const originalRandomBytes = mutableCrypto.randomBytes;
    const originalTimingSafeEqual = mutableCrypto.timingSafeEqual;
    const hmacProbe = originalCreateHmac("sha256", vectorKey);
    const hmacPrototype = Object.getPrototypeOf(hmacProbe) as object;
    const updateDescriptor = Object.getOwnPropertyDescriptor(
      hmacPrototype,
      "update",
    )!;
    const digestDescriptor = Object.getOwnPropertyDescriptor(
      hmacPrototype,
      "digest",
    )!;
    hmacProbe.digest();
    const baseline = ring().issue("invite");
    const unequalLeft = bytes(0x10);
    const unequalRight = bytes(0x20);
    let createHmacCalls = 0;
    let randomBytesCalls = 0;
    let timingSafeEqualCalls = 0;
    let deterministicAfterMutation: typeof baseline | undefined;
    let defaultEntropyAfterMutation: typeof baseline | undefined;
    let unequalAccepted: boolean | undefined;
    try {
      mutableCrypto.createHmac = (() => {
        createHmacCalls += 1;
        throw new Error(marker);
      }) as typeof mutableCrypto.createHmac;
      mutableCrypto.randomBytes = ((size: number) => {
        randomBytesCalls += 1;
        return Buffer.alloc(size, 0x41);
      }) as typeof mutableCrypto.randomBytes;
      mutableCrypto.timingSafeEqual = ((): boolean => {
        timingSafeEqualCalls += 1;
        return true;
      }) as typeof mutableCrypto.timingSafeEqual;
      syncBuiltinESMExports();
      Object.defineProperty(hmacPrototype, "update", {
        ...updateDescriptor,
        value() {
          throw new Error(marker);
        },
      });
      Object.defineProperty(hmacPrototype, "digest", {
        ...digestDescriptor,
        value() {
          throw new Error(marker);
        },
      });

      deterministicAfterMutation = ring().issue("invite");
      defaultEntropyAfterMutation = new SecretKeyRing({
        currentVersion: 2,
        verificationKeys: [{ version: 2, key: vectorKey }],
      }).issue("invite");
      unequalAccepted = constantTimeDigestEqual(unequalLeft, unequalRight);
    } finally {
      Object.defineProperty(hmacPrototype, "update", updateDescriptor);
      Object.defineProperty(hmacPrototype, "digest", digestDescriptor);
      mutableCrypto.createHmac = originalCreateHmac;
      mutableCrypto.randomBytes = originalRandomBytes;
      mutableCrypto.timingSafeEqual = originalTimingSafeEqual;
      syncBuiltinESMExports();
    }

    expect(deterministicAfterMutation).toEqual(baseline);
    expect(defaultEntropyAfterMutation?.wireValue).toMatch(/^i1\.2\./u);
    expect(defaultEntropyAfterMutation?.wireValue).not.toBe(
      `i1.2.${Buffer.alloc(32, 0x41).toString("base64url")}`,
    );
    expect(unequalAccepted).toBe(false);
    expect({ createHmacCalls, randomBytesCalls, timingSafeEqualCalls }).toEqual(
      {
        createHmacCalls: 0,
        randomBytesCalls: 0,
        timingSafeEqualCalls: 0,
      },
    );
    expect(
      JSON.stringify([
        deterministicAfterMutation,
        defaultEntropyAfterMutation,
        unequalAccepted,
      ]),
    ).not.toContain(marker);
  });

  it.each([
    [
      "invite",
      "i1",
      "fe1280e9b160f3faff124349d0d26ceb3990a60b9d09464afa831b2ceda73901",
    ],
    [
      "session",
      "s1",
      "9552d48c536fb215a05820ae7f1f9a5bd984bf45287a84eb9e6c392b33ec47fd",
    ],
    [
      "csrf",
      "c1",
      "d6f1688f202f87678f07041bd35e7a768710bcc4e6582fabf5be3b137e8f73b5",
    ],
  ] as const)(
    "matches the independently computed %s HMAC-SHA-256 vector",
    (kind, prefix, expectedDigest) => {
      const issued = ring().issue(kind);

      expect(issued.wireValue).toBe(`${prefix}.2.${vectorSecretEncoded}`);
      expect(hex(issued.persistence.digest)).toBe(expectedDigest);
      expect(issued.persistence.digest).toHaveLength(32);
      expect(ring().verify(kind, issued.wireValue)).toEqual(issued.persistence);
    },
  );

  it("issues only with the current version and verifies current and previous versions", () => {
    const previousIssuer = new SecretKeyRing(
      {
        currentVersion: 1,
        verificationKeys: [{ version: 1, key: bytes(0x40) }],
      },
      { randomBytes: fixedRandom() },
    );
    const previous = previousIssuer.issue("invite");
    const rotated = ring();
    const current = rotated.issue("invite");

    expect(current.wireValue).toMatch(/^i1\.2\./u);
    expect(previous.wireValue).toMatch(/^i1\.1\./u);
    expect(rotated.verify("invite", current.wireValue)).toEqual(
      current.persistence,
    );
    expect(rotated.verify("invite", previous.wireValue)).toEqual(
      previous.persistence,
    );
  });

  it("distinguishes retired and unknown versions without retaining retired keys", () => {
    const configured = ring();
    const retired = `i1.3.${vectorSecretEncoded}`;
    const unknown = `i1.4.${vectorSecretEncoded}`;

    expect(captureError(() => configured.verify("invite", retired)).code).toBe(
      "retired_version",
    );
    expect(captureError(() => configured.verify("invite", unknown)).code).toBe(
      "unknown_version",
    );
    expect(Reflect.ownKeys(configured)).toEqual([]);
    expect(JSON.stringify(configured)).toBe("{}");
  });

  it("snapshots caller key bytes before mutation", () => {
    const callerKey = Uint8Array.from(vectorKey);
    const configured = new SecretKeyRing(
      {
        currentVersion: 2,
        verificationKeys: [{ version: 2, key: callerKey }],
      },
      { randomBytes: fixedRandom() },
    );
    callerKey.fill(0xff);

    expect(hex(configured.issue("invite").persistence.digest)).toBe(
      "fe1280e9b160f3faff124349d0d26ceb3990a60b9d09464afa831b2ceda73901",
    );
  });

  it("copies exact-length injected random bytes and calls the source for 32 bytes", () => {
    const callerBytes = Uint8Array.from(vectorSecret);
    const requestedLengths: number[] = [];
    const configured = ring({}, (byteLength) => {
      requestedLengths.push(byteLength);
      return callerBytes;
    });
    const issued = configured.issue("session");
    callerBytes.fill(0);

    expect(requestedLengths).toEqual([32]);
    expect(issued.wireValue).toBe(`s1.2.${vectorSecretEncoded}`);
    expect(configured.verify("session", issued.wireValue)).toEqual(
      issued.persistence,
    );
  });

  it.each([31, 33])(
    "rejects an injected random result of %i bytes",
    (length) => {
      const configured = ring({}, () => new Uint8Array(length));

      expect(captureError(() => configured.issue("invite")).code).toBe(
        "invalid_random_bytes",
      );
    },
  );

  it("rejects a non-byte random result", () => {
    const configured = ring(
      {},
      (() => "not bytes") as unknown as () => Uint8Array,
    );

    expect(captureError(() => configured.issue("invite")).code).toBe(
      "invalid_random_bytes",
    );
  });

  it("normalizes an injected random-source failure", () => {
    const marker = "random-source-secret-marker";
    const configured = ring({}, () => {
      throw new Error(marker);
    });
    const error = captureError(() => configured.issue("invite"));

    expect(error.code).toBe("invalid_random_bytes");
    expect(String(error)).not.toContain(marker);
  });

  it("uses the default Node random source with exact canonical entropy shape", () => {
    const configured = new SecretKeyRing({
      currentVersion: 1,
      verificationKeys: [{ version: 1, key: vectorKey }],
    });

    for (const kind of ["invite", "session", "csrf"] as const) {
      for (let generation = 0; generation < 4; generation += 1) {
        const issued = configured.issue(kind);
        const segments = issued.wireValue.split(".");
        const decoded = Buffer.from(segments[2]!, "base64url");

        expect(segments).toHaveLength(3);
        expect(segments[1]).toBe("1");
        expect(segments[2]).toMatch(/^[A-Za-z0-9_-]{43}$/u);
        expect(decoded).toHaveLength(32);
        expect(decoded.toString("base64url")).toBe(segments[2]);
        expect(issued.persistence.digest).toHaveLength(32);
      }
    }
  });
});

describe("SecretKeyRing parsing and matching", () => {
  it("uses captured parsing, collection, byte, numeric, apply, and freeze intrinsics", () => {
    const marker = "post-load-secret-intrinsic-marker";
    const configured = new SecretKeyRing(
      {
        currentVersion: 2,
        verificationKeys: [
          { version: 1, key: bytes(0x40) },
          { version: 2, key: vectorKey },
        ],
        retiredVersions: [3],
      },
      { randomBytes: () => vectorSecret },
    );
    const valid = configured.issue("invite");
    const reconstructionKeys = [
      { version: 1, key: bytes(0x40) },
      { version: 2, key: Uint8Array.from(vectorKey) },
    ];
    const targets = [
      [Array, "isArray"],
      [Number, "isInteger"],
      [Number, "isSafeInteger"],
      [RegExp.prototype, "test"],
      [String.prototype, "split"],
      [Object, "freeze"],
      [Reflect, "apply"],
      [Uint8Array, "from"],
      [Uint8Array.prototype, "set"],
      [Uint8Array.prototype, Symbol.iterator],
      [Map.prototype, "get"],
      [Map.prototype, "has"],
      [Map.prototype, "set"],
      [Set.prototype, "add"],
      [Set.prototype, "has"],
    ] as const;
    const descriptors = targets.map(([target, property]) =>
      intrinsicGetOwnPropertyDescriptor(target, property),
    );
    const hasInstanceDescriptor = intrinsicGetOwnPropertyDescriptor(
      Uint8Array,
      Symbol.hasInstance,
    );
    let issued: ReturnType<SecretKeyRing["issue"]> | undefined;
    let verified: SecretPersistenceMaterial | undefined;
    let malformedError: unknown;
    let reconstructed: SecretKeyRing | undefined;
    try {
      for (let index = 0; index < targets.length; index += 1) {
        const [target, property] = targets[index]!;
        intrinsicDefineProperty(target, property, {
          ...descriptors[index],
          configurable: true,
          value: () => {
            throw new Error(marker);
          },
        });
      }
      intrinsicDefineProperty(Uint8Array, Symbol.hasInstance, {
        configurable: true,
        value: () => false,
      });

      issued = configured.issue("invite");
      verified = configured.verify("invite", valid.wireValue);
      try {
        configured.verify("invite", `i1.2.${"!".repeat(43)}`);
      } catch (error) {
        malformedError = error;
      }
      reconstructed = new SecretKeyRing(
        {
          currentVersion: 2,
          verificationKeys: reconstructionKeys,
          retiredVersions: [3],
        },
        { randomBytes: () => vectorSecret },
      );
    } finally {
      for (let index = 0; index < targets.length; index += 1) {
        const [target, property] = targets[index]!;
        const descriptor = descriptors[index];
        if (descriptor === undefined) {
          intrinsicReflectDeleteProperty(target, property);
        } else {
          intrinsicDefineProperty(target, property, descriptor);
        }
      }
      if (hasInstanceDescriptor === undefined) {
        intrinsicReflectDeleteProperty(Uint8Array, Symbol.hasInstance);
      } else {
        intrinsicDefineProperty(
          Uint8Array,
          Symbol.hasInstance,
          hasInstanceDescriptor,
        );
      }
    }

    expect(issued?.wireValue).toBe(valid.wireValue);
    expect(verified).toEqual(valid.persistence);
    expect(malformedError).toBeInstanceOf(SecretPrimitiveError);
    expect(malformedError).toMatchObject({ code: "invalid_token" });
    expect(reconstructed).toBeInstanceOf(SecretKeyRing);
    expect(String(malformedError)).not.toContain(marker);
  });

  it("returns persistence-only material from issue and verification", () => {
    const configured = ring();
    const issued = configured.issue("csrf");
    const verified = configured.verify("csrf", issued.wireValue);

    expect(persistenceHasNoPlaintext).toBe(true);
    expect(Object.keys(issued.persistence).sort()).toEqual([
      "digest",
      "keyVersion",
    ]);
    expect(Object.keys(verified).sort()).toEqual(["digest", "keyVersion"]);
    expect("secret" in issued.persistence).toBe(false);
    expect("wireValue" in issued.persistence).toBe(false);
    expect("secret" in verified).toBe(false);
    expect("wireValue" in verified).toBe(false);
  });

  it("makes canonical secret tampering fail an exact digest match", () => {
    const configured = ring();
    const issued = configured.issue("invite");
    const replacement = issued.wireValue.endsWith("8") ? "4" : "8";
    const tampered = `${issued.wireValue.slice(0, -1)}${replacement}`;
    const tamperedMaterial = configured.verify("invite", tampered);

    expect(
      constantTimeDigestEqual(
        issued.persistence.digest,
        tamperedMaterial.digest,
      ),
    ).toBe(false);
  });

  it.each([
    ["invite", `s1.2.${vectorSecretEncoded}`],
    ["session", `c1.2.${vectorSecretEncoded}`],
    ["csrf", `i1.2.${vectorSecretEncoded}`],
  ] as const)("rejects a wrong-kind %s token", (kind, token) => {
    expect(captureError(() => ring().verify(kind, token)).code).toBe(
      "wrong_token_kind",
    );
  });

  it.each([
    "",
    "i1",
    "i1.2",
    `i1.2.${vectorSecretEncoded}.extra`,
    `x1.2.${vectorSecretEncoded}`,
    `i1.2.${vectorSecretEncoded}=`,
    `i1.2.${vectorSecretEncoded.slice(0, -1)}+`,
    `i1.2.${vectorSecretEncoded.slice(0, -1)}/`,
    `i1.2.${vectorSecretEncoded.slice(0, -1)}`,
    `i1.2.${vectorSecretEncoded}A`,
    `i1.2.${vectorSecretEncoded.slice(0, -1)}9`,
    `i1.2.${vectorSecretEncoded.slice(0, 21)}.${vectorSecretEncoded.slice(21)}`,
    `i1.1.0.${vectorSecretEncoded}`,
    `i1.2.${"A".repeat(10_000)}`,
  ])("rejects malformed token %j", (token) => {
    expect(captureError(() => ring().verify("invite", token)).code).toBe(
      "invalid_token",
    );
  });

  it.each(["0", "00", "01", "+1", "-1", " 1", "1 ", "1e0", "32768", "99999"])(
    "rejects noncanonical or out-of-range version %j",
    (version) => {
      expect(
        captureError(() =>
          ring().verify("invite", `i1.${version}.${vectorSecretEncoded}`),
        ).code,
      ).toBe("invalid_version");
    },
  );

  it("accepts canonical boundary versions 1 and 32767", () => {
    for (const version of [1, 32_767]) {
      const configured = new SecretKeyRing(
        {
          currentVersion: version,
          verificationKeys: [{ version, key: vectorKey }],
        },
        { randomBytes: fixedRandom() },
      );
      const issued = configured.issue("invite");

      expect(issued.wireValue).toBe(
        `i1.${String(version)}.${vectorSecretEncoded}`,
      );
      expect(configured.verify("invite", issued.wireValue)).toEqual(
        issued.persistence,
      );
    }
  });

  it("compares only exact 32-byte digests", () => {
    const digest = bytes(0x70);
    const equalCopy = Uint8Array.from(digest);
    const changed = Uint8Array.from(digest);
    changed[31] = changed[31]! ^ 1;

    expect(constantTimeDigestEqual(digest, equalCopy)).toBe(true);
    expect(constantTimeDigestEqual(digest, changed)).toBe(false);
    expect(constantTimeDigestEqual(digest, new Uint8Array(31))).toBe(false);
    expect(constantTimeDigestEqual(new Uint8Array(33), digest)).toBe(false);
    expect(
      constantTimeDigestEqual("not bytes" as unknown as Uint8Array, digest),
    ).toBe(false);
  });
});

describe("SecretKeyRing configuration", () => {
  it("rejects an empty or oversized active key ring", () => {
    expect(
      captureError(() => ring({ currentVersion: 1, verificationKeys: [] }))
        .code,
    ).toBe("oversized_key_ring");
    expect(
      captureError(() =>
        ring({
          currentVersion: 1,
          verificationKeys: [1, 2, 3, 4].map((version) => ({
            version,
            key: bytes(version),
          })),
        }),
      ).code,
    ).toBe("oversized_key_ring");
  });

  it("rejects duplicate active and retired versions", () => {
    expect(
      captureError(() =>
        ring({
          currentVersion: 1,
          verificationKeys: [
            { version: 1, key: bytes(1) },
            { version: 1, key: bytes(2) },
          ],
          retiredVersions: [],
        }),
      ).code,
    ).toBe("duplicate_version");
    expect(captureError(() => ring({ retiredVersions: [3, 3] })).code).toBe(
      "duplicate_version",
    );
  });

  it("rejects a missing current version and active-retired overlap", () => {
    expect(
      captureError(() =>
        ring({
          currentVersion: 2,
          verificationKeys: [{ version: 1, key: bytes(1) }],
          retiredVersions: [],
        }),
      ).code,
    ).toBe("current_version_missing");
    expect(captureError(() => ring({ retiredVersions: [1] })).code).toBe(
      "retired_version_overlap",
    );
  });

  it("rejects invalid configured versions and key lengths", () => {
    for (const version of [0, -1, 1.5, 32_768, Number.NaN]) {
      expect(
        captureError(() =>
          ring({
            currentVersion: 1,
            verificationKeys: [{ version, key: bytes(1) }],
            retiredVersions: [],
          }),
        ).code,
      ).toBe("invalid_version");
    }

    for (const length of [0, 31, 33]) {
      expect(
        captureError(() =>
          ring({
            currentVersion: 1,
            verificationKeys: [{ version: 1, key: new Uint8Array(length) }],
            retiredVersions: [],
          }),
        ).code,
      ).toBe("invalid_key");
    }
  });

  it("bounds the retired-version collection before indexing it", () => {
    const retiredVersions = Array.from(
      { length: 32_768 },
      (_, index) => (index % 32_767) + 1,
    );

    expect(captureError(() => ring({ retiredVersions })).code).toBe(
      "oversized_retired_versions",
    );
  });

  it("uses typed bounded secret-free errors that retain no raw input", () => {
    const marker = "plaintext-marker-that-must-not-survive";
    const error = captureError(() => ring().verify("invite", `i1.4.${marker}`));
    const rendered = [
      error.name,
      error.code,
      error.message,
      String(error),
      JSON.stringify(error),
      ...Reflect.ownKeys(error).map(String),
    ].join("\n");

    expect(error.message.length).toBeLessThanOrEqual(64);
    expect(rendered).not.toContain(marker);
    expect(Reflect.ownKeys(error)).not.toContain("token");
    expect(Reflect.ownKeys(error)).not.toContain("key");
    expect(Reflect.ownKeys(error)).not.toContain("digest");
  });

  it("rejects invalid runtime kinds and configuration shapes", () => {
    expect(captureError(() => ring().issue("other" as SecretKind)).code).toBe(
      "invalid_kind",
    );
    expect(
      captureError(
        () => new SecretKeyRing(null as unknown as SecretKeyRingConfig),
      ).code,
    ).toBe("invalid_configuration");
  });
});

describe("SecretKeyRing hostile input normalization", () => {
  const marker = "hostile-secret-marker";

  function expectNormalizedError(
    action: () => unknown,
    expectedCode: SecretPrimitiveError["code"],
  ): void {
    const error = captureError(action);
    const rendered = [
      error.name,
      error.code,
      error.message,
      error.stack,
      String(error),
      JSON.stringify(error),
    ].join("\n");

    expect(error.code).toBe(expectedCode);
    expect(rendered).not.toContain(marker);
  }

  it("snapshots top-level and entry getters exactly once", () => {
    const callerKey = Uint8Array.from(vectorKey);
    let currentVersionReads = 0;
    let verificationKeysReads = 0;
    let retiredVersionsReads = 0;
    let randomBytesReads = 0;
    let entryVersionReads = 0;
    let entryKeyReads = 0;
    const entry = {
      get version() {
        entryVersionReads += 1;
        return entryVersionReads === 1 ? 1 : 2;
      },
      get key() {
        entryKeyReads += 1;
        return entryKeyReads === 1 ? callerKey : bytes(0x80);
      },
    };
    const config = {
      get currentVersion() {
        currentVersionReads += 1;
        return currentVersionReads === 1 ? 1 : 2;
      },
      get verificationKeys() {
        verificationKeysReads += 1;
        return verificationKeysReads === 1
          ? [entry]
          : [{ version: 2, key: bytes(0x80) }];
      },
      get retiredVersions() {
        retiredVersionsReads += 1;
        return retiredVersionsReads === 1 ? [] : [1];
      },
    };
    const options = {
      get randomBytes() {
        randomBytesReads += 1;
        return randomBytesReads === 1
          ? fixedRandom()
          : () => new Uint8Array(32);
      },
    };

    const configured = new SecretKeyRing(config, options);
    callerKey.fill(0xff);
    const issued = configured.issue("invite");

    expect({
      currentVersionReads,
      verificationKeysReads,
      retiredVersionsReads,
      randomBytesReads,
      entryVersionReads,
      entryKeyReads,
    }).toEqual({
      currentVersionReads: 1,
      verificationKeysReads: 1,
      retiredVersionsReads: 1,
      randomBytesReads: 1,
      entryVersionReads: 1,
      entryKeyReads: 1,
    });
    expect(issued.wireValue).toBe(`i1.1.${vectorSecretEncoded}`);
    expect(hex(issued.persistence.digest)).toBe(
      "fe1280e9b160f3faff124349d0d26ceb3990a60b9d09464afa831b2ceda73901",
    );
  });

  it("bounds the captured array length and never invokes a hostile iterator", () => {
    const target = Array.from({ length: 1_000 }, (_, index) => ({
      version: index + 1,
      key: bytes(index),
    }));
    let lengthReads = 0;
    let iteratorReads = 0;
    const entries = new Proxy(target, {
      get(array, property, receiver) {
        if (property === "length") {
          lengthReads += 1;
          return lengthReads <= 2 ? 1 : 1_000;
        }
        if (property === Symbol.iterator) {
          iteratorReads += 1;
          throw new Error(marker);
        }
        return Reflect.get(array, property, receiver);
      },
    });
    const configured = new SecretKeyRing(
      {
        currentVersion: 1,
        verificationKeys: entries,
      },
      { randomBytes: fixedRandom() },
    );

    expect(configured.issue("session").wireValue).toBe(
      `s1.1.${vectorSecretEncoded}`,
    );
    expect(lengthReads).toBe(1);
    expect(iteratorReads).toBe(0);
  });

  it("rejects a captured active length above three before reading entries", () => {
    let entryReads = 0;
    let iteratorReads = 0;
    const entries = new Proxy(
      Array.from({ length: 4 }, (_, version) => ({
        version: version + 1,
        key: bytes(version),
      })),
      {
        get(target, property, receiver) {
          if (property === Symbol.iterator) {
            iteratorReads += 1;
            throw new Error(marker);
          }
          if (typeof property === "string" && /^[0-9]+$/u.test(property)) {
            entryReads += 1;
            throw new Error(marker);
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );

    expectNormalizedError(
      () =>
        new SecretKeyRing({
          currentVersion: 1,
          verificationKeys: entries,
        }),
      "oversized_key_ring",
    );
    expect(entryReads).toBe(0);
    expect(iteratorReads).toBe(0);
  });

  it("normalizes configuration access, entry access, and key-copy traps", () => {
    const validEntry = { version: 1, key: vectorKey };
    const throwingArray = new Proxy([validEntry], {
      get(target, property, receiver) {
        if (property === "length") {
          throw new Error(marker);
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const throwingIndex = [validEntry];
    Object.defineProperty(throwingIndex, "0", {
      get() {
        throw new Error(marker);
      },
    });
    const revokedConfig = Proxy.revocable(
      {
        currentVersion: 1,
        verificationKeys: [validEntry],
      },
      {},
    );
    revokedConfig.revoke();
    const revokedKey = Proxy.revocable(new Uint8Array(32), {});
    revokedKey.revoke();

    const cases: ReadonlyArray<{
      readonly expectedCode: SecretPrimitiveError["code"];
      readonly action: () => unknown;
    }> = [
      {
        expectedCode: "invalid_configuration",
        action: () =>
          new SecretKeyRing(
            Object.defineProperty(
              { verificationKeys: [validEntry] },
              "currentVersion",
              {
                get() {
                  throw new Error(marker);
                },
              },
            ) as unknown as SecretKeyRingConfig,
          ),
      },
      {
        expectedCode: "invalid_configuration",
        action: () =>
          new SecretKeyRing(
            revokedConfig.proxy as unknown as SecretKeyRingConfig,
          ),
      },
      {
        expectedCode: "invalid_configuration",
        action: () =>
          new SecretKeyRing({
            currentVersion: 1,
            verificationKeys: throwingArray,
          }),
      },
      {
        expectedCode: "invalid_configuration",
        action: () =>
          new SecretKeyRing({
            currentVersion: 1,
            verificationKeys: throwingIndex,
          }),
      },
      {
        expectedCode: "invalid_configuration",
        action: () =>
          new SecretKeyRing({
            currentVersion: 1,
            verificationKeys: [
              Object.defineProperty({ key: vectorKey }, "version", {
                get() {
                  throw new Error(marker);
                },
              }) as unknown as { version: number; key: Uint8Array },
            ],
          }),
      },
      {
        expectedCode: "invalid_configuration",
        action: () =>
          new SecretKeyRing({
            currentVersion: 1,
            verificationKeys: [
              Object.defineProperty({ version: 1 }, "key", {
                get() {
                  throw new Error(marker);
                },
              }) as { version: number; key: Uint8Array },
            ],
          }),
      },
      {
        expectedCode: "invalid_key",
        action: () =>
          new SecretKeyRing({
            currentVersion: 1,
            verificationKeys: [
              {
                version: 1,
                key: revokedKey.proxy as unknown as Uint8Array,
              },
            ],
          }),
      },
      {
        expectedCode: "invalid_configuration",
        action: () =>
          new SecretKeyRing(
            {
              currentVersion: 1,
              verificationKeys: [validEntry],
            },
            Object.defineProperty({}, "randomBytes", {
              get() {
                throw new Error(marker);
              },
            }),
          ),
      },
    ];

    for (const entry of cases) {
      expectNormalizedError(entry.action, entry.expectedCode);
    }
  });

  it("normalizes hostile random invocation, inspection, and copy failures", () => {
    const revokedBytes = Proxy.revocable(new Uint8Array(32), {});
    revokedBytes.revoke();
    const hostileBytes = new Proxy(new Uint8Array(32), {
      getPrototypeOf() {
        throw new Error(marker);
      },
    });
    const hostileSource = new Proxy(fixedRandom(), {
      apply() {
        throw new Error(marker);
      },
    });

    for (const randomBytes of [
      hostileSource,
      () => hostileBytes,
      () => revokedBytes.proxy as unknown as Uint8Array,
    ]) {
      const configured = ring({}, randomBytes);
      expectNormalizedError(
        () => configured.issue("invite"),
        "invalid_random_bytes",
      );
    }
  });

  it("copies typed arrays without consulting hostile iteration properties", () => {
    const source = Uint8Array.from(vectorSecret);
    Object.defineProperty(source, Symbol.iterator, {
      get() {
        throw new Error(marker);
      },
    });
    const configured = ring({}, () => source);

    expect(configured.issue("csrf").wireValue).toBe(
      `c1.2.${vectorSecretEncoded}`,
    );
  });

  it("returns false for hostile and revoked digest values without leaking", () => {
    const hostile = new Proxy(new Uint8Array(32), {
      getPrototypeOf() {
        throw new Error(marker);
      },
    });
    const revoked = Proxy.revocable(new Uint8Array(32), {});
    revoked.revoke();

    expect(() => constantTimeDigestEqual(hostile, vectorKey)).not.toThrow();
    expect(constantTimeDigestEqual(hostile, vectorKey)).toBe(false);
    expect(
      constantTimeDigestEqual(
        revoked.proxy as unknown as Uint8Array,
        vectorKey,
      ),
    ).toBe(false);
  });

  it("rejects a hostile runtime kind without property-key coercion", () => {
    const hostileKind = {
      [Symbol.toPrimitive]() {
        throw new Error(marker);
      },
    } as unknown as SecretKind;

    expectNormalizedError(() => ring().issue(hostileKind), "invalid_kind");
  });
});
