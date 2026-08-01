import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";

import { describe, expect, it, vi } from "vitest";

import {
  OperationConflictError,
  OperationDeniedError,
  OperationInternalError,
  type PgCompatibleClient,
  type PgCompatiblePool,
  type PgCompatibleQueryResult,
} from "./invitation-repository.js";
import { SecretKeyRing } from "./secrets.js";
import {
  SessionRepository,
  type SessionSecurityEvent,
  type SessionSecurityEventSink,
} from "./session-repository.js";
import { createVerifiedPrincipalFromServerVerification } from "./verified-principal.js";

const requestId = "10000000-0000-4000-8000-000000000001";
const membershipId = "10000000-0000-4000-8000-000000000002";
const sessionId = "10000000-0000-4000-8000-000000000003";
const auditId = "10000000-0000-4000-8000-000000000004";
const successorId = "10000000-0000-4000-8000-000000000005";
const successorAuditId = "10000000-0000-4000-8000-000000000006";
const targetSessionId = "10000000-0000-4000-8000-000000000007";
const targetMembershipId = "10000000-0000-4000-8000-000000000008";
const mutationAuditId = "10000000-0000-4000-8000-000000000009";
const userId = "20000000-0000-4000-8000-000000000001";
const organizationId = "20000000-0000-4000-8000-000000000002";
const databaseNow = new Date("2026-08-01T00:00:00.500Z");
const idleExpiry = new Date("2026-08-01T00:30:00.500Z");
const absoluteExpiry = new Date("2026-08-08T00:00:00.500Z");
const revokedAt = new Date("2026-08-01T00:00:00.000Z");
const secretMarker = "task7-wire-secret-marker";
const intrinsicDefineProperty = Object.defineProperty;
const intrinsicGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const intrinsicReflectDeleteProperty = Reflect.deleteProperty;

function bytes(seed: number): Uint8Array {
  return Uint8Array.from({ length: 32 }, (_, index) => (seed + index) & 0xff);
}

function keyRing(randomBytes?: (length: number) => Uint8Array): SecretKeyRing {
  let seed = 1;
  return new SecretKeyRing(
    {
      currentVersion: 2,
      verificationKeys: [
        { version: 1, key: bytes(11) },
        { version: 2, key: bytes(22) },
      ],
      retiredVersions: [3],
    },
    { randomBytes: randomBytes ?? (() => bytes(seed++)) },
  );
}

interface QueryCall {
  readonly text: string;
  readonly values?: readonly unknown[];
}

class FakeClient implements PgCompatibleClient {
  readonly calls: QueryCall[] = [];
  readonly releases: Array<boolean | undefined> = [];
  readonly #select: (
    text: string,
    values?: readonly unknown[],
  ) => PgCompatibleQueryResult;
  readonly #failure?: { readonly statement: string; readonly error: unknown };
  readonly #rollbackFailure?: unknown;
  readonly #releaseFailure?: unknown;
  readonly #releaseResult?: (destroy?: boolean) => unknown;

  constructor(
    options: {
      select?: (
        text: string,
        values?: readonly unknown[],
      ) => PgCompatibleQueryResult;
      failure?: { readonly statement: string; readonly error: unknown };
      rollbackFailure?: unknown;
      releaseFailure?: unknown;
      releaseResult?: (destroy?: boolean) => unknown;
    } = {},
  ) {
    this.#select = options.select ?? (() => contextRow());
    this.#failure = options.failure;
    this.#rollbackFailure = options.rollbackFailure;
    this.#releaseFailure = options.releaseFailure;
    this.#releaseResult = options.releaseResult;
  }

  async query(
    text: string,
    values?: unknown[],
  ): Promise<PgCompatibleQueryResult> {
    this.calls.push({ text, values });
    if (text === "ROLLBACK" && this.#rollbackFailure !== undefined) {
      throw this.#rollbackFailure;
    }
    if (
      this.#failure?.statement === text ||
      (this.#failure?.statement === "SELECT" && text.startsWith("SELECT")) ||
      (this.#failure?.statement === "INITIALIZE" &&
        text.includes("initialize_context")) ||
      (this.#failure?.statement === "OPERATION" &&
        text.startsWith("SELECT") &&
        !text.includes("initialize_context"))
    ) {
      throw this.#failure.error;
    }
    if (text.startsWith("SELECT")) return this.#select(text, values);
    return { rowCount: null, rows: [] };
  }

  release(destroy?: boolean): unknown {
    this.releases.push(destroy);
    if (this.#releaseFailure !== undefined) throw this.#releaseFailure;
    return this.#releaseResult?.(destroy);
  }
}

function contextRow(
  overrides: Record<string, unknown> = {},
): PgCompatibleQueryResult {
  return {
    rowCount: 1,
    rows: [
      {
        session_id: sessionId,
        user_id: userId,
        organization_id: organizationId,
        membership_id: membershipId,
        authority_revision: "7",
        idle_expires_at: new Date(idleExpiry),
        absolute_expires_at: new Date(absoluteExpiry),
        database_now: new Date(databaseNow),
        ...overrides,
      },
    ],
  };
}

function issueRow(
  overrides: Record<string, unknown> = {},
): PgCompatibleQueryResult {
  return {
    rowCount: 1,
    rows: [
      {
        user_id: userId,
        organization_id: organizationId,
        membership_id: membershipId,
        granted_role: "admin",
        authority_revision: "7",
        session_id: sessionId,
        idle_expires_at: new Date(idleExpiry),
        absolute_expires_at: new Date(absoluteExpiry),
        database_now: new Date(databaseNow),
        ...overrides,
      },
    ],
  };
}

function pool(
  client: PgCompatibleClient,
): PgCompatiblePool & { connect: ReturnType<typeof vi.fn> } {
  return { connect: vi.fn(async () => client) };
}

function uuidSource(values: readonly string[]): () => string {
  let index = 0;
  return () => values[index++] ?? "30000000-0000-4000-8000-000000000001";
}

function repository(options: {
  readonly client: PgCompatibleClient;
  readonly ring?: SecretKeyRing;
  readonly uuids?: readonly string[];
  readonly events?: SessionSecurityEvent[];
  readonly customPool?: PgCompatiblePool;
  readonly sink?: SessionSecurityEventSink;
}): SessionRepository {
  return new SessionRepository({
    pool: options.customPool ?? pool(options.client),
    keyRing: options.ring ?? keyRing(),
    deploymentRevision: "task7-repository",
    securityEventSink:
      options.sink ??
      ((event) => {
        options.events?.push(event);
        return true;
      }),
    uuidSource: uuidSource(options.uuids ?? [sessionId, auditId]),
  });
}

function principal() {
  return createVerifiedPrincipalFromServerVerification({
    issuer: "https://issuer.example/immutable",
    subject: "Exact-Subject",
    emailVerified: true,
    verifiedEmail: "ignored-for-session-issue@example.test",
  });
}

function authenticated(ring: SecretKeyRing) {
  return {
    sessionToken: ring.issue("session").wireValue,
    csrfValue: ring.issue("csrf").wireValue,
  };
}

async function captureError(operation: Promise<unknown>): Promise<Error> {
  return operation.then(
    () => {
      throw new Error("expected rejection");
    },
    (error: unknown) => error as Error,
  );
}

function render(error: unknown): string {
  return [
    String(error),
    JSON.stringify(error),
    error instanceof Error ? error.message : "",
  ].join("\n");
}

describe("SessionRepository successful boundaries", () => {
  it("issues from exact immutable identity with DB winners and DB-clock cookie", async () => {
    const ring = keyRing();
    const client = new FakeClient({ select: () => issueRow() });
    const result = await repository({ client, ring }).issueSession({
      requestId,
      principal: principal(),
      membershipId,
    });

    expect(client.calls.map(({ text }) => text)).toEqual([
      "BEGIN",
      "SET LOCAL search_path = pg_catalog",
      expect.stringContaining("FROM dasher_api.issue_session("),
      "COMMIT",
    ]);
    const operation = client.calls[2]!;
    expect(operation.text.match(/\$[0-9]+::/g)).toHaveLength(11);
    expect(operation.values).toHaveLength(11);
    expect(operation.values?.slice(0, 5)).toEqual([
      "https://issuer.example/immutable",
      "Exact-Subject",
      membershipId,
      sessionId,
      2,
    ]);
    expect(operation.values?.[8]).toBe(auditId);
    expect(operation.values?.[9]).toBe(requestId);
    expect(operation.values?.[10]).toBe("task7-repository");
    expect(
      operation.values?.filter((value) => value instanceof Uint8Array),
    ).toHaveLength(2);
    expect(result).toMatchObject({
      userId,
      organizationId,
      membershipId,
      role: "admin",
      authorityRevision: 7,
      sessionId,
      sessionCookie: { maxAge: 604_800 },
    });
    expect(JSON.stringify(operation.values)).not.toContain(result.sessionToken);
    expect(JSON.stringify(operation.values)).not.toContain(result.csrfValue);
    expect(client.releases).toEqual([undefined]);
  });

  it("resolves with initialize_context as the transaction-local operation", async () => {
    const ring = keyRing();
    const sessionToken = ring.issue("session").wireValue;
    const client = new FakeClient();
    const result = await repository({ client, ring }).resolveSession({
      requestId,
      sessionToken,
    });

    expect(client.calls.map(({ text }) => text)).toEqual([
      "BEGIN",
      "SET LOCAL search_path = pg_catalog",
      expect.stringContaining("FROM dasher_api.initialize_context("),
      "COMMIT",
    ]);
    expect(client.calls[2]?.values).toHaveLength(3);
    expect(client.calls[2]?.values?.[2]).toBe(requestId);
    expect(JSON.stringify(client.calls[2]?.values)).not.toContain(sessionToken);
    expect(result).toMatchObject({
      sessionId,
      userId,
      organizationId,
      membershipId,
      authorityRevision: 7,
      sessionCookie: { maxAge: 604_800 },
    });
  });

  it("rotates only after context initialization on the same pinned client", async () => {
    const ring = keyRing();
    const proof = authenticated(ring);
    const client = new FakeClient({
      select: (text) =>
        text.includes("initialize_context")
          ? contextRow()
          : {
              rowCount: 1,
              rows: [
                {
                  session_id: successorId,
                  idle_expires_at: new Date(idleExpiry),
                  absolute_expires_at: new Date(absoluteExpiry),
                  database_now: new Date(databaseNow),
                },
              ],
            },
    });
    const result = await repository({
      client,
      ring,
      uuids: [successorId, successorAuditId],
    }).rotateSession({
      requestId,
      currentSessionToken: proof.sessionToken,
      currentCsrfValue: proof.csrfValue,
    });

    expect(client.calls.map(({ text }) => text)).toEqual([
      "BEGIN",
      "SET LOCAL search_path = pg_catalog",
      expect.stringContaining("FROM dasher_api.initialize_context("),
      expect.stringContaining("FROM dasher_api.rotate_session("),
      "COMMIT",
    ]);
    expect(client.calls[3]?.values).toHaveLength(9);
    expect(client.calls[3]?.values?.[0]).toBe(successorId);
    expect(client.calls[3]?.values?.[5]).toBe(successorAuditId);
    expect(client.calls[3]?.values?.[8]).toBe("task7-repository");
    expect(JSON.stringify(client.calls)).not.toContain(proof.sessionToken);
    expect(JSON.stringify(client.calls)).not.toContain(proof.csrfValue);
    expect(JSON.stringify(client.calls)).not.toContain(result.sessionToken);
    expect(JSON.stringify(client.calls)).not.toContain(result.csrfValue);
    expect(result).toMatchObject({
      sessionId: successorId,
      sessionCookie: { maxAge: 604_800 },
    });
  });

  it("runs revoke and membership mutations with exact signatures after context", async () => {
    const cases = [
      {
        method: "revokeSession" as const,
        input: { targetSessionId },
        functionName: "revoke_session",
        parameterCount: 5,
        row: {
          session_id: targetSessionId,
          revoked_at: new Date(revokedAt),
          database_now: new Date(databaseNow),
        },
      },
      {
        method: "changeMembershipRole" as const,
        input: { membershipId: targetMembershipId, newRole: "editor" as const },
        functionName: "change_membership_role",
        parameterCount: 6,
        row: { membership_id: targetMembershipId, authority_revision: "8" },
      },
      {
        method: "revokeMembership" as const,
        input: { membershipId: targetMembershipId },
        functionName: "revoke_membership",
        parameterCount: 5,
        row: {
          membership_id: targetMembershipId,
          authority_revision: "8",
          revoked_at: new Date(revokedAt),
          database_now: new Date(databaseNow),
        },
      },
    ];

    for (const testCase of cases) {
      const ring = keyRing();
      const proof = authenticated(ring);
      const verifiedSession = ring.verify("session", proof.sessionToken);
      const verifiedCsrf = ring.verify("csrf", proof.csrfValue);
      const client = new FakeClient({
        select: (text) =>
          text.includes("initialize_context")
            ? contextRow()
            : { rowCount: 1, rows: [testCase.row] },
      });
      const repo = repository({ client, ring, uuids: [mutationAuditId] });
      const result = await repo[testCase.method]({
        requestId,
        currentSessionToken: proof.sessionToken,
        currentCsrfValue: proof.csrfValue,
        ...testCase.input,
      } as never);

      expect(client.calls.map(({ text }) => text)).toEqual([
        "BEGIN",
        "SET LOCAL search_path = pg_catalog",
        expect.stringContaining("FROM dasher_api.initialize_context("),
        expect.stringContaining(`FROM dasher_api.${testCase.functionName}(`),
        "COMMIT",
      ]);
      expect(client.calls[2]?.values).toEqual([
        verifiedSession.keyVersion,
        verifiedSession.digest,
        requestId,
      ]);
      const expectedOperationValues =
        testCase.method === "revokeSession"
          ? [
              targetSessionId,
              mutationAuditId,
              verifiedCsrf.keyVersion,
              verifiedCsrf.digest,
              "task7-repository",
            ]
          : testCase.method === "changeMembershipRole"
            ? [
                targetMembershipId,
                "editor",
                mutationAuditId,
                verifiedCsrf.keyVersion,
                verifiedCsrf.digest,
                "task7-repository",
              ]
            : [
                targetMembershipId,
                mutationAuditId,
                verifiedCsrf.keyVersion,
                verifiedCsrf.digest,
                "task7-repository",
              ];
      expect(expectedOperationValues).toHaveLength(testCase.parameterCount);
      expect(client.calls[3]?.values).toEqual(expectedOperationValues);
      expect(JSON.stringify(client.calls)).not.toContain(proof.sessionToken);
      expect(JSON.stringify(client.calls)).not.toContain(proof.csrfValue);
      expect(result).toBeDefined();
    }
  });

  it("returns fresh Date snapshots that caller mutation cannot retain", async () => {
    const ring = keyRing();
    const client = new FakeClient({ select: () => issueRow() });
    const result = await repository({ client, ring }).issueSession({
      requestId,
      principal: principal(),
      membershipId,
    });
    const firstIdle = result.idleExpiresAt;
    firstIdle.setTime(0);
    expect(result.idleExpiresAt).not.toBe(firstIdle);
    expect(result.idleExpiresAt).toEqual(idleExpiry);
    expect(Object.isFrozen(result)).toBe(true);
  });
});

describe("SessionRepository denial, validation, and stage classification", () => {
  it.each([
    ["malformed", "not-a-token"],
    ["wrong kind", keyRing().issue("csrf").wireValue],
    ["retired", "s1.3.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"],
    ["unknown", "s1.32767.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"],
  ])(
    "denies %s caller session material without connecting",
    async (_label, sessionToken) => {
      const connectedPool = { connect: vi.fn(async () => new FakeClient()) };
      const error = await captureError(
        repository({
          client: new FakeClient(),
          customPool: connectedPool,
        }).resolveSession({ requestId, sessionToken }),
      );
      expect(error).toBeInstanceOf(OperationDeniedError);
      expect(connectedPool.connect).not.toHaveBeenCalled();
    },
  );

  it("distinguishes repository CSPRNG failure as generic internal before connect", async () => {
    const ring = keyRing(() => {
      throw new Error(secretMarker);
    });
    const connectedPool = { connect: vi.fn(async () => new FakeClient()) };
    const error = await captureError(
      repository({
        client: new FakeClient(),
        ring,
        customPool: connectedPool,
      }).issueSession({
        requestId,
        principal: principal(),
        membershipId,
      }),
    );
    expect(error).toBeInstanceOf(OperationInternalError);
    expect(render(error)).not.toContain(secretMarker);
    expect(connectedPool.connect).not.toHaveBeenCalled();
  });

  it.each([
    { idle_expires_at: new Date(databaseNow) },
    { absolute_expires_at: new Date(databaseNow) },
    { idle_expires_at: new Date("2026-08-09T00:00:00.000Z") },
    { authority_revision: "0" },
    { authority_revision: "9007199254740992" },
    { session_id: "NOT-CANONICAL" },
    { granted_role: "owner" },
    { database_now: new Date(Number.NaN) },
  ])(
    "rejects hostile or relationally invalid output and rolls back: %o",
    async (override) => {
      const ring = keyRing();
      const client = new FakeClient({ select: () => issueRow(override) });
      const error = await captureError(
        repository({ client, ring }).issueSession({
          requestId,
          principal: principal(),
          membershipId,
        }),
      );
      expect(error).toBeInstanceOf(OperationInternalError);
      expect(client.calls.at(-1)?.text).toBe("ROLLBACK");
    },
  );

  it.each([
    ["INITIALIZE", "P1001", OperationDeniedError],
    ["OPERATION", "P1001", OperationDeniedError],
    ["OPERATION", "P1002", OperationConflictError],
  ] as const)(
    "maps exact own-data %s %s",
    async (statement, code, expected) => {
      const ring = keyRing();
      const proof = authenticated(ring);
      const client = new FakeClient({
        failure: { statement, error: { code, marker: secretMarker } },
      });
      const error = await captureError(
        repository({
          client,
          ring,
          uuids: [successorId, successorAuditId],
        }).rotateSession({
          requestId,
          currentSessionToken: proof.sessionToken,
          currentCsrfValue: proof.csrfValue,
        }),
      );
      expect(error).toBeInstanceOf(expected);
      expect(render(error)).not.toContain(secretMarker);
    },
  );

  it.each(["BEGIN", "SET LOCAL search_path = pg_catalog", "COMMIT"])(
    "never trusts boundary SQLSTATE from %s",
    async (statement) => {
      const ring = keyRing();
      const client = new FakeClient({
        select: () => issueRow(),
        failure: { statement, error: { code: "P1001", marker: secretMarker } },
      });
      const error = await captureError(
        repository({ client, ring }).issueSession({
          requestId,
          principal: principal(),
          membershipId,
        }),
      );
      expect(error).toBeInstanceOf(OperationInternalError);
      expect(error).toMatchObject({
        outcome:
          statement === "COMMIT" ? "commit_indeterminate" : "not_committed",
        retrySafe: false,
      });
      expect(render(error)).not.toContain(secretMarker);
      if (statement === "COMMIT") {
        expect(client.releases).toEqual([true]);
        expect(client.calls.map(({ text }) => text)).not.toContain("ROLLBACK");
      }
    },
  );

  it("does not trust inherited/accessor SQLSTATE", async () => {
    for (const databaseError of [
      Object.create({ code: "P1001" }),
      Object.defineProperty({}, "code", { get: () => "P1002" }),
    ]) {
      const ring = keyRing();
      const client = new FakeClient({
        select: () => issueRow(),
        failure: { statement: "SELECT", error: databaseError },
      });
      await expect(
        repository({ client, ring }).issueSession({
          requestId,
          principal: principal(),
          membershipId,
        }),
      ).rejects.toBeInstanceOf(OperationInternalError);
    }
  });
});

describe("SessionRepository hostile values and cleanup", () => {
  it("captures every configuration seam once before later getters mutate it", async () => {
    const ring = keyRing();
    const client = new FakeClient({ select: () => issueRow() });
    const originalConnect = vi.fn(async () => client);
    const swappedConnect = vi.fn(async () => {
      throw new Error(secretMarker);
    });
    const originalSink = vi.fn<SessionSecurityEventSink>(() => true);
    const swappedSink = vi.fn<SessionSecurityEventSink>(() => true);
    const trustedPool = { connect: originalConnect };
    const reads: string[] = [];
    const config = {
      get pool() {
        reads.push("pool");
        return trustedPool;
      },
      get keyRing() {
        reads.push("keyRing");
        trustedPool.connect = swappedConnect;
        return ring;
      },
      get deploymentRevision() {
        reads.push("deploymentRevision");
        return "captured-task7";
      },
      get securityEventSink() {
        reads.push("securityEventSink");
        return originalSink;
      },
      get uuidSource() {
        reads.push("uuidSource");
        intrinsicDefineProperty(config, "securityEventSink", {
          configurable: true,
          value: swappedSink,
        });
        return uuidSource([sessionId, auditId]);
      },
    };
    const repo = new SessionRepository(config);
    await repo.issueSession({
      requestId,
      principal: principal(),
      membershipId,
    });

    expect(reads).toEqual([
      "pool",
      "keyRing",
      "deploymentRevision",
      "securityEventSink",
      "uuidSource",
    ]);
    expect(originalConnect).toHaveBeenCalledOnce();
    expect(swappedConnect).not.toHaveBeenCalled();
    expect(client.calls[2]?.values?.[10]).toBe("captured-task7");
    expect(originalSink).not.toHaveBeenCalled();
    expect(swappedSink).not.toHaveBeenCalled();
  });

  it("captures client query and release once with their original receiver", async () => {
    const ring = keyRing();
    const calls: QueryCall[] = [];
    const releases: Array<boolean | undefined> = [];
    let queryReads = 0;
    let releaseReads = 0;
    let swappedCalls = 0;
    const client = {
      get query() {
        queryReads += 1;
        return async function (
          this: unknown,
          text: string,
          values?: unknown[],
        ) {
          expect(this).toBe(client);
          calls.push({ text, values });
          if (text.startsWith("SELECT")) return issueRow();
          return { rowCount: null, rows: [] };
        };
      },
      get release() {
        releaseReads += 1;
        intrinsicDefineProperty(client, "query", {
          configurable: true,
          value: async () => {
            swappedCalls += 1;
            throw new Error(secretMarker);
          },
        });
        return function (this: unknown, destroy?: boolean) {
          expect(this).toBe(client);
          releases.push(destroy);
        };
      },
    };
    await repository({
      client: client as PgCompatibleClient,
      ring,
    }).issueSession({
      requestId,
      principal: principal(),
      membershipId,
    });
    expect(queryReads).toBe(1);
    expect(releaseReads).toBe(1);
    expect(swappedCalls).toBe(0);
    expect(calls.map(({ text }) => text)).toEqual([
      "BEGIN",
      "SET LOCAL search_path = pg_catalog",
      expect.stringContaining("issue_session"),
      "COMMIT",
    ]);
    expect(releases).toEqual([undefined]);
  });

  it("uses only the captured release capability when client validation fails", async () => {
    const ring = keyRing();
    const releases: Array<boolean | undefined> = [];
    let queryReads = 0;
    let releaseReads = 0;
    const proxyReads = { query: 0, release: 0 };
    const target = {
      get query() {
        queryReads += 1;
        return 17;
      },
      get release() {
        releaseReads += 1;
        if (releaseReads !== 1) throw new Error(secretMarker);
        return function (this: unknown, destroy?: boolean) {
          expect(this).toBe(client);
          releases.push(destroy);
        };
      },
    };
    const client = new Proxy(target, {
      get(proxyTarget, property, receiver) {
        if (property === "query") proxyReads.query += 1;
        if (property === "release") proxyReads.release += 1;
        return Reflect.get(proxyTarget, property, receiver);
      },
    });
    const error = await captureError(
      repository({
        client: client as unknown as PgCompatibleClient,
        ring,
      }).issueSession({ requestId, principal: principal(), membershipId }),
    );
    expect(error).toBeInstanceOf(OperationInternalError);
    expect(render(error)).not.toContain(secretMarker);
    expect(queryReads).toBe(1);
    expect(releaseReads).toBe(1);
    expect(proxyReads).toEqual({ query: 1, release: 1 });
    expect(releases).toEqual([true]);
  });

  it("reads requestId and each relevant input value once", async () => {
    const ring = keyRing();
    const sessionToken = ring.issue("session").wireValue;
    const reads = { requestId: 0, sessionToken: 0 };
    const input = {
      get requestId() {
        reads.requestId += 1;
        return requestId;
      },
      get sessionToken() {
        reads.sessionToken += 1;
        return sessionToken;
      },
    };
    await repository({ client: new FakeClient(), ring }).resolveSession(input);
    expect(reads).toEqual({ requestId: 1, sessionToken: 1 });
  });

  it("snapshots all mutation getters coherently before connect", async () => {
    const ring = keyRing();
    const proof = authenticated(ring);
    const reads = {
      requestId: 0,
      currentSessionToken: 0,
      currentCsrfValue: 0,
      membershipId: 0,
      newRole: 0,
    };
    let allowConnect!: () => void;
    const barrier = new Promise<void>((resolve) => {
      allowConnect = resolve;
    });
    const client = new FakeClient({
      select: (text) =>
        text.includes("initialize_context")
          ? contextRow()
          : {
              rowCount: 1,
              rows: [
                { membership_id: targetMembershipId, authority_revision: "8" },
              ],
            },
    });
    const customPool = {
      async connect() {
        await barrier;
        return client;
      },
    };
    const input = {
      get requestId() {
        reads.requestId += 1;
        return requestId;
      },
      get currentSessionToken() {
        reads.currentSessionToken += 1;
        return proof.sessionToken;
      },
      get currentCsrfValue() {
        reads.currentCsrfValue += 1;
        return proof.csrfValue;
      },
      get membershipId() {
        reads.membershipId += 1;
        return targetMembershipId;
      },
      get newRole() {
        reads.newRole += 1;
        return "editor" as const;
      },
    };
    const operation = repository({
      client,
      ring,
      uuids: [mutationAuditId],
      customPool,
    }).changeMembershipRole(input);
    intrinsicDefineProperty(input, "membershipId", {
      value: "deadbeef-dead-4bad-8bad-deadbeefdead",
    });
    allowConnect();
    await expect(operation).resolves.toEqual({
      membershipId: targetMembershipId,
      authorityRevision: 8,
    });
    expect(reads).toEqual({
      requestId: 1,
      currentSessionToken: 1,
      currentCsrfValue: 1,
      membershipId: 1,
      newRole: 1,
    });
    expect(client.calls[3]?.values?.[0]).toBe(targetMembershipId);
  });

  it("reads successful row cardinality, array index, and each field once", async () => {
    const ring = keyRing();
    const baseRow = issueRow().rows[0] as Record<string, unknown>;
    const fieldReads = new Map<PropertyKey, number>();
    const row = new Proxy(baseRow, {
      getOwnPropertyDescriptor(target, property) {
        fieldReads.set(property, (fieldReads.get(property) ?? 0) + 1);
        return intrinsicGetOwnPropertyDescriptor(target, property);
      },
    });
    let lengthReads = 0;
    let rowReads = 0;
    const rows = new Proxy([row], {
      get(target, property, receiver) {
        if (property === "length") lengthReads += 1;
        if (property === "0") rowReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    const result = {
      rowCount: 1,
      rows,
    };
    const client = new FakeClient({ select: () => result });
    await repository({ client, ring }).issueSession({
      requestId,
      principal: principal(),
      membershipId,
    });
    expect(lengthReads).toBe(1);
    expect(rowReads).toBe(1);
    for (const field of [
      "user_id",
      "organization_id",
      "membership_id",
      "granted_role",
      "authority_revision",
      "session_id",
      "idle_expires_at",
      "absolute_expires_at",
      "database_now",
    ]) {
      expect(fieldReads.get(field)).toBe(1);
    }
  });

  it("normalizes hostile row, result, and revoked array proxies with rollback", async () => {
    const revoked = Proxy.revocable([issueRow().rows[0]], {});
    revoked.revoke();
    const hostileResults: PgCompatibleQueryResult[] = [
      new Proxy(issueRow(), {
        getOwnPropertyDescriptor() {
          throw new Error(secretMarker);
        },
      }),
      {
        rowCount: 1,
        rows: [
          new Proxy(issueRow().rows[0] as object, {
            getOwnPropertyDescriptor() {
              throw new Error(secretMarker);
            },
          }),
        ],
      },
      { rowCount: 1, rows: revoked.proxy },
    ];
    for (const selectResult of hostileResults) {
      const ring = keyRing();
      const client = new FakeClient({ select: () => selectResult });
      const error = await captureError(
        repository({ client, ring }).issueSession({
          requestId,
          principal: principal(),
          membershipId,
        }),
      );
      expect(error).toBeInstanceOf(OperationInternalError);
      expect(render(error)).not.toContain(secretMarker);
      expect(client.calls.at(-1)?.text).toBe("ROLLBACK");
    }
  });

  it("accepts synchronous telemetry acknowledgement with only canonical ID plus reason", async () => {
    const events: SessionSecurityEvent[] = [];
    let uuidReads = 0;
    const repo = new SessionRepository({
      pool: pool(new FakeClient()),
      keyRing: keyRing(),
      deploymentRevision: "task7-repository",
      securityEventSink: (event) => {
        events.push(event);
        return true;
      },
      uuidSource: () => {
        uuidReads += 1;
        return requestId;
      },
    });
    await expect(
      repo.resolveSession({
        requestId: `bad-${secretMarker}`,
        sessionToken: secretMarker,
      }),
    ).rejects.toBeInstanceOf(OperationDeniedError);
    expect(uuidReads).toBe(1);
    expect(events).toEqual([{ requestId, reason: "input_invalid" }]);
    expect(JSON.stringify(events)).not.toContain(secretMarker);
  });

  it("keeps an invalid telemetry acknowledgement non-authoritative and secret-free", async () => {
    const invalidSink = vi.fn(() => false);
    const connectedPool = pool(new FakeClient());
    const error = await captureError(
      new SessionRepository({
        pool: connectedPool,
        keyRing: keyRing(),
        deploymentRevision: "task7-repository",
        securityEventSink: invalidSink as unknown as SessionSecurityEventSink,
        uuidSource: () => requestId,
      }).resolveSession({
        requestId: `bad-${secretMarker}`,
        sessionToken: secretMarker,
      }),
    );
    expect(error).toBeInstanceOf(OperationDeniedError);
    expect(render(error)).not.toContain(secretMarker);
    expect(invalidSink).toHaveBeenCalledOnce();
    expect(invalidSink).toHaveBeenCalledWith({
      requestId,
      reason: "input_invalid",
    });
    expect(connectedPool.connect).not.toHaveBeenCalled();
  });

  it("classifies invalid mutation input before a failing UUID source", async () => {
    const ring = keyRing();
    const proof = authenticated(ring);
    const connectedPool = pool(new FakeClient());
    const repo = new SessionRepository({
      pool: connectedPool,
      keyRing: ring,
      deploymentRevision: "task7-repository",
      securityEventSink: () => true,
      uuidSource: () => {
        throw new Error(secretMarker);
      },
    });
    await expect(
      repo.changeMembershipRole({
        requestId,
        currentSessionToken: proof.sessionToken,
        currentCsrfValue: proof.csrfValue,
        membershipId: "bad-membership",
        newRole: "editor",
      }),
    ).rejects.toBeInstanceOf(OperationDeniedError);
    expect(connectedPool.connect).not.toHaveBeenCalled();
  });

  it("destructively releases after rollback failure and hides all markers", async () => {
    const ring = keyRing();
    const client = new FakeClient({
      select: () => issueRow(),
      failure: {
        statement: "BEGIN",
        error: new Error(`begin-${secretMarker}`),
      },
      rollbackFailure: new Error(`rollback-${secretMarker}`),
    });
    const error = await captureError(
      repository({ client, ring }).issueSession({
        requestId,
        principal: principal(),
        membershipId,
      }),
    );
    expect(error).toBeInstanceOf(OperationInternalError);
    expect(render(error)).not.toContain(secretMarker);
    expect(client.calls.map(({ text }) => text)).toEqual(["BEGIN", "ROLLBACK"]);
    expect(client.releases).toEqual([true]);
  });

  it("keeps committed results authoritative after sync, Promise, and thenable release failure", async () => {
    for (const client of [
      new FakeClient({
        select: () => issueRow(),
        releaseFailure: new Error(secretMarker),
      }),
      new FakeClient({
        select: () => issueRow(),
        releaseResult: (destroy) =>
          destroy
            ? Promise.reject(new Error(secretMarker))
            : Promise.reject(new Error(secretMarker)),
      }),
      new FakeClient({
        select: () => issueRow(),
        releaseResult: (destroy) =>
          destroy
            ? undefined
            : {
                then(
                  _onFulfilled: (value: unknown) => void,
                  onRejected: (reason: unknown) => void,
                ) {
                  onRejected(new Error(secretMarker));
                },
              },
      }),
    ]) {
      const ring = keyRing();
      await expect(
        repository({ client, ring }).issueSession({
          requestId,
          principal: principal(),
          membershipId,
        }),
      ).resolves.toMatchObject({ sessionId });
      await vi.waitFor(() =>
        expect(client.releases).toEqual([undefined, true]),
      );
    }
  });

  it("does not await a never-settling destructive release thenable", async () => {
    const ring = keyRing();
    const client = new FakeClient({
      select: () => issueRow(),
      releaseResult: (destroy) =>
        destroy ? { then() {} } : Promise.reject(new Error(secretMarker)),
    });
    await expect(
      repository({ client, ring }).issueSession({
        requestId,
        principal: principal(),
        membershipId,
      }),
    ).resolves.toMatchObject({ sessionId });
    await vi.waitFor(() => expect(client.releases).toEqual([undefined, true]));
  });

  it("does not await a never-settling cleanup thenable", async () => {
    const ring = keyRing();
    const client = new FakeClient({
      select: () => issueRow(),
      releaseResult: () => ({ then() {} }),
    });
    await expect(
      repository({ client, ring }).issueSession({
        requestId,
        principal: principal(),
        membershipId,
      }),
    ).resolves.toMatchObject({ sessionId });
    expect(client.releases).toEqual([undefined]);
  });

  it("normalizes revoked proxies and hostile sink failures without leaking", async () => {
    const ring = keyRing();
    const { proxy, revoke } = Proxy.revocable(
      { requestId, sessionToken: ring.issue("session").wireValue },
      {},
    );
    revoke();
    const events: SessionSecurityEvent[] = [];
    const error = await captureError(
      repository({
        client: new FakeClient(),
        ring,
        events,
        sink: () => {
          throw new Error(secretMarker);
        },
      }).resolveSession(proxy as never),
    );
    expect(error).toBeInstanceOf(OperationDeniedError);
    expect(render(error)).not.toContain(secretMarker);
  });

  it("retains module-captured crypto randomUUID after syncBuiltinESMExports", async () => {
    const mutableCrypto = crypto as typeof crypto;
    const originalRandomUuid = mutableCrypto.randomUUID;
    let poisonedCalls = 0;
    const ring = keyRing();
    const client = new FakeClient({
      select: (_text, values) => issueRow({ session_id: values?.[3] }),
    });
    let result:
      Awaited<ReturnType<SessionRepository["issueSession"]>> | undefined;
    try {
      mutableCrypto.randomUUID = (() => {
        poisonedCalls += 1;
        return "deadbeef-dead-4bad-8bad-deadbeefdead";
      }) as typeof mutableCrypto.randomUUID;
      syncBuiltinESMExports();
      result = await new SessionRepository({
        pool: pool(client),
        keyRing: ring,
        deploymentRevision: "task7-repository",
        securityEventSink: () => true,
      }).issueSession({ requestId, principal: principal(), membershipId });
    } finally {
      mutableCrypto.randomUUID = originalRandomUuid;
      syncBuiltinESMExports();
    }
    expect(result?.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
    );
    expect(result?.sessionId).not.toBe("deadbeef-dead-4bad-8bad-deadbeefdead");
    expect(poisonedCalls).toBe(0);
  });

  it("uses captured validation and key-ring capabilities", async () => {
    const ring = keyRing();
    const sessionToken = ring.issue("session").wireValue;
    const client = new FakeClient();
    let allowConnect!: (client: PgCompatibleClient) => void;
    const connectBarrier = new Promise<PgCompatibleClient>((resolve) => {
      allowConnect = resolve;
    });
    const repo = repository({
      client,
      ring,
      customPool: { connect: () => connectBarrier },
    });
    const descriptors = [
      [RegExp.prototype, "test"],
      [String.prototype, "charCodeAt"],
      [SecretKeyRing.prototype, "issue"],
      [SecretKeyRing.prototype, "verify"],
    ] as const;
    const originals = descriptors.map(([target, property]) =>
      intrinsicGetOwnPropertyDescriptor(target, property),
    );
    let operation: Promise<unknown> | undefined;
    try {
      for (let index = 0; index < descriptors.length; index += 1) {
        const [target, property] = descriptors[index]!;
        const descriptor = originals[index]!;
        intrinsicDefineProperty(target, property, {
          ...descriptor,
          value: () => {
            throw new Error(secretMarker);
          },
        });
      }
      operation = repo.resolveSession({
        requestId,
        sessionToken,
      });
    } finally {
      for (let index = descriptors.length - 1; index >= 0; index -= 1) {
        const [target, property] = descriptors[index]!;
        const descriptor = originals[index];
        if (descriptor === undefined) {
          intrinsicReflectDeleteProperty(target, property);
        } else {
          intrinsicDefineProperty(target, property, descriptor);
        }
      }
    }
    allowConnect(client);
    await expect(operation).resolves.toMatchObject({
      sessionId,
      userId,
      organizationId,
      membershipId,
      authorityRevision: 7,
    });
    expect(client.releases).toEqual([undefined]);
  });
});
