import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";

import { describe, expect, it, vi } from "vitest";

import { normalizeEmailAddress } from "./email.js";
import {
  InvitationRepository,
  OperationConflictError,
  OperationDeniedError,
  OperationInternalError,
  type InvitationSecurityEvent,
  type PgCompatibleClient,
  type PgCompatiblePool,
  type PgCompatibleQueryResult,
} from "./invitation-repository.js";
import { SecretKeyRing } from "./secrets.js";
import { createVerifiedPrincipalFromServerVerification } from "./verified-principal.js";

const intrinsicDateSetTime = Date.prototype.setTime;
const intrinsicDefineProperty = Object.defineProperty;
const intrinsicGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const intrinsicObjectFreeze = Object.freeze;
const intrinsicReflectApply = Reflect.apply;

const requestId = "10000000-0000-4000-8000-000000000001";
const invitationId = "10000000-0000-4000-8000-000000000002";
const auditId = "10000000-0000-4000-8000-000000000003";
const proposedUserId = "10000000-0000-4000-8000-000000000004";
const proposedMembershipId = "10000000-0000-4000-8000-000000000005";
const proposedSessionId = "10000000-0000-4000-8000-000000000006";
const acceptAuditId = "10000000-0000-4000-8000-000000000007";
const winningUserId = "20000000-0000-4000-8000-000000000001";
const organizationId = "20000000-0000-4000-8000-000000000002";
const winningMembershipId = "20000000-0000-4000-8000-000000000003";
const secretMarker = "wire-token-secret-marker";

function bytes(seed: number): Uint8Array {
  return Uint8Array.from({ length: 32 }, (_, index) => (seed + index) & 0xff);
}

function keyRing(
  randomSource?: (byteLength: number) => Uint8Array,
): SecretKeyRing {
  let randomSeed = 1;
  return new SecretKeyRing(
    {
      currentVersion: 2,
      verificationKeys: [
        { version: 1, key: bytes(10) },
        { version: 2, key: bytes(20) },
      ],
      retiredVersions: [3],
    },
    {
      randomBytes: randomSource ?? (() => bytes(randomSeed++)),
    },
  );
}

interface QueryCall {
  readonly text: string;
  readonly values?: readonly unknown[];
}

class FakeClient implements PgCompatibleClient {
  readonly calls: QueryCall[] = [];
  readonly releases: Array<boolean | undefined> = [];
  readonly #selectResult:
    | PgCompatibleQueryResult
    | ((
        text: string,
        values: readonly unknown[] | undefined,
      ) => PgCompatibleQueryResult);
  readonly #failure?: { statement: string; error: unknown };
  readonly #rollbackFailure?: unknown;
  readonly #releaseFailure?: unknown;
  readonly #releaseResult?: (destroy: boolean | undefined) => unknown;

  constructor(options: {
    selectResult:
      | PgCompatibleQueryResult
      | ((
          text: string,
          values: readonly unknown[] | undefined,
        ) => PgCompatibleQueryResult);
    failure?: { statement: string; error: unknown };
    rollbackFailure?: unknown;
    releaseFailure?: unknown;
    releaseResult?: (destroy: boolean | undefined) => unknown;
  }) {
    this.#selectResult = options.selectResult;
    this.#failure = options.failure;
    this.#rollbackFailure = options.rollbackFailure;
    this.#releaseFailure = options.releaseFailure;
    this.#releaseResult = options.releaseResult;
  }

  async query(
    text: string,
    values?: unknown[],
  ): Promise<PgCompatibleQueryResult> {
    this.calls.push(intrinsicObjectFreeze({ text, values }));
    if (text === "ROLLBACK" && this.#rollbackFailure !== undefined) {
      throw this.#rollbackFailure;
    }
    if (
      this.#failure?.statement === text ||
      (this.#failure?.statement === "SELECT" && text.startsWith("SELECT"))
    ) {
      throw this.#failure.error;
    }
    if (text.startsWith("SELECT")) {
      return typeof this.#selectResult === "function"
        ? this.#selectResult(text, values)
        : this.#selectResult;
    }
    return { rowCount: null, rows: [] };
  }

  release(destroy?: boolean): unknown {
    this.releases.push(destroy);
    if (this.#releaseFailure !== undefined) {
      throw this.#releaseFailure;
    }
    return this.#releaseResult?.(destroy);
  }
}

function pool(client: FakeClient): PgCompatiblePool {
  return { connect: vi.fn(async () => client) };
}

function uuids(values: readonly string[]): () => string {
  let index = 0;
  return () => values[index++] ?? "30000000-0000-4000-8000-000000000001";
}

function issueRow(
  overrides: Record<string, unknown> = {},
): PgCompatibleQueryResult {
  return {
    rowCount: 1,
    rows: [
      {
        invitation_id: invitationId,
        expires_at: new Date("2026-08-07T00:00:00.000Z"),
        ...overrides,
      },
    ],
  };
}

function acceptRow(
  overrides: Record<string, unknown> = {},
): PgCompatibleQueryResult {
  return {
    rowCount: 1,
    rows: [
      {
        user_id: winningUserId,
        organization_id: organizationId,
        membership_id: winningMembershipId,
        granted_role: "editor",
        authority_revision: "9",
        session_id: proposedSessionId,
        idle_expires_at: new Date("2026-08-01T01:00:00.000Z"),
        absolute_expires_at: new Date("2026-08-08T00:00:00.500Z"),
        database_now: new Date("2026-08-01T00:00:00.500Z"),
        ...overrides,
      },
    ],
  };
}

function principal() {
  return createVerifiedPrincipalFromServerVerification({
    issuer: "https://issuer.example/immutable",
    subject: "immutable-subject",
    emailVerified: true,
    verifiedEmail: "INVITED@EXAMPLE.TEST",
  });
}

function issueInput(ring: SecretKeyRing) {
  const session = ring.issue("session");
  const csrf = ring.issue("csrf");
  return {
    requestId,
    email: "INVITED@EXAMPLE.TEST",
    role: "editor" as const,
    currentSessionToken: session.wireValue,
    currentCsrfValue: csrf.wireValue,
  };
}

function repository(options: {
  client: FakeClient;
  ring?: SecretKeyRing;
  events?: InvitationSecurityEvent[];
  uuidValues?: readonly string[];
  sink?: (event: InvitationSecurityEvent) => void | Promise<void>;
  deploymentRevision?: string;
  customPool?: PgCompatiblePool;
}) {
  return new InvitationRepository({
    pool: options.customPool ?? pool(options.client),
    keyRing: options.ring ?? keyRing(),
    deploymentRevision: options.deploymentRevision ?? "task6-repository",
    securityEventSink:
      options.sink ??
      ((event) => {
        options.events?.push(event);
      }),
    uuidSource: uuids(
      options.uuidValues ?? [
        invitationId,
        auditId,
        proposedUserId,
        proposedMembershipId,
        proposedSessionId,
        acceptAuditId,
      ],
    ),
  });
}

function capturedError(value: Promise<unknown>): Promise<Error> {
  return value.then(
    () => {
      throw new Error("expected operation to fail");
    },
    (error: unknown) => error as Error,
  );
}

function render(value: unknown): string {
  return [
    String(value),
    JSON.stringify(value),
    ...(value instanceof Error ? [value.message] : []),
  ].join("\n");
}

describe("InvitationRepository successful operations", () => {
  it("issues with one pinned serial transaction, exact signature, and persistence-only params", async () => {
    const ring = keyRing();
    const input = issueInput(ring);
    const client = new FakeClient({ selectResult: issueRow() });
    const result = await repository({
      client,
      ring,
      uuidValues: [invitationId, auditId],
    }).issueInvitation(input);

    expect(client.calls.map((call) => call.text)).toEqual([
      "BEGIN",
      "SET LOCAL search_path = pg_catalog",
      expect.stringContaining("FROM dasher_api.issue_invitation("),
      "COMMIT",
    ]);
    const select = client.calls[2]!;
    expect(select.text.match(/\$[0-9]+::/g)).toHaveLength(12);
    expect(select.values).toHaveLength(12);
    expect(select.values?.slice(0, 4)).toEqual([
      invitationId,
      "invited@example.test",
      "editor",
      2,
    ]);
    expect(select.values?.[5]).toBe(auditId);
    expect(select.values?.[10]).toBe(requestId);
    expect(select.values?.[11]).toBe("task6-repository");
    expect(
      select.values?.filter((value) => value instanceof Uint8Array),
    ).toHaveLength(3);
    expect(JSON.stringify(select.values)).not.toContain(
      input.currentSessionToken,
    );
    expect(JSON.stringify(select.values)).not.toContain(input.currentCsrfValue);
    expect(JSON.stringify(select.values)).not.toContain(result.inviteToken);
    expect(result).toEqual({
      invitationId,
      expiresAt: new Date("2026-08-07T00:00:00.000Z"),
      inviteToken: expect.stringMatching(/^i1\.2\./),
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(client.releases).toEqual([undefined]);
  });

  it("accepts using immutable identity, returns DB winners, and derives exact cookie from DB clock", async () => {
    const ring = keyRing();
    const invite = ring.issue("invite");
    const client = new FakeClient({ selectResult: acceptRow() });
    const result = await repository({
      client,
      ring,
      uuidValues: [
        proposedUserId,
        proposedMembershipId,
        proposedSessionId,
        acceptAuditId,
      ],
    }).acceptInvitation({
      requestId,
      inviteToken: invite.wireValue,
      principal: principal(),
    });

    expect(client.calls.map((call) => call.text)).toEqual([
      "BEGIN",
      "SET LOCAL search_path = pg_catalog",
      expect.stringContaining("FROM dasher_api.accept_invitation("),
      "COMMIT",
    ]);
    const select = client.calls[2]!;
    expect(select.text).toContain(
      "pg_catalog.clock_timestamp() AS database_now",
    );
    expect(select.text.match(/\$[0-9]+::/g)).toHaveLength(16);
    expect(select.values).toHaveLength(16);
    expect(select.values?.slice(2, 9)).toEqual([
      "https://issuer.example/immutable",
      "immutable-subject",
      "invited@example.test",
      true,
      proposedUserId,
      proposedMembershipId,
      proposedSessionId,
    ]);
    expect(select.values?.[13]).toBe(acceptAuditId);
    expect(select.values?.[14]).toBe(requestId);
    expect(select.values?.[15]).toBe("task6-repository");
    expect(JSON.stringify(select.values)).not.toContain(invite.wireValue);
    expect(JSON.stringify(select.values)).not.toContain(result.sessionToken);
    expect(JSON.stringify(select.values)).not.toContain(result.csrfValue);
    expect(result).toMatchObject({
      userId: winningUserId,
      organizationId,
      membershipId: winningMembershipId,
      sessionId: proposedSessionId,
      role: "editor",
      authorityRevision: 9,
      sessionCookie: {
        name: "__Host-dasher_session",
        secure: true,
        httpOnly: true,
        path: "/",
        sameSite: "lax",
        maxAge: 604_800,
      },
    });
    expect(result.userId).not.toBe(proposedUserId);
    expect(result.membershipId).not.toBe(proposedMembershipId);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.sessionCookie)).toBe(true);
  });

  it("does not resolve before COMMIT completes", async () => {
    let allowCommit!: () => void;
    const commitBarrier = new Promise<void>((resolve) => {
      allowCommit = resolve;
    });
    const ring = keyRing();
    const client = new FakeClient({ selectResult: issueRow() });
    const originalQuery = client.query.bind(client);
    client.query = async (text, values) => {
      if (text === "COMMIT") {
        await commitBarrier;
      }
      return originalQuery(text, values);
    };
    let settled = false;
    const operation = repository({
      client,
      ring,
      uuidValues: [invitationId, auditId],
    })
      .issueInvitation(issueInput(ring))
      .finally(() => {
        settled = true;
      });
    await vi.waitFor(() =>
      expect(client.calls.some((call) => call.text.startsWith("SELECT"))).toBe(
        true,
      ),
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    allowCommit();
    await expect(operation).resolves.toMatchObject({ invitationId });
  });

  it("returns fresh immutable timestamp snapshots on every result access", async () => {
    const ring = keyRing();
    const issueClient = new FakeClient({ selectResult: issueRow() });
    const issued = await repository({
      client: issueClient,
      ring,
      uuidValues: [invitationId, auditId],
    }).issueInvitation(issueInput(ring));
    const firstExpiry = issued.expiresAt;
    intrinsicReflectApply(intrinsicDateSetTime, firstExpiry, [0]);
    expect(issued.expiresAt).not.toBe(firstExpiry);
    expect(issued.expiresAt.toISOString()).toBe("2026-08-07T00:00:00.000Z");

    const invite = ring.issue("invite");
    const acceptClient = new FakeClient({ selectResult: acceptRow() });
    const accepted = await repository({
      client: acceptClient,
      ring,
      uuidValues: [
        proposedUserId,
        proposedMembershipId,
        proposedSessionId,
        acceptAuditId,
      ],
    }).acceptInvitation({
      requestId,
      inviteToken: invite.wireValue,
      principal: principal(),
    });
    const firstIdle = accepted.idleExpiresAt;
    const firstAbsolute = accepted.absoluteExpiresAt;
    const cookie = { ...accepted.sessionCookie };
    intrinsicReflectApply(intrinsicDateSetTime, firstIdle, [0]);
    intrinsicReflectApply(intrinsicDateSetTime, firstAbsolute, [0]);

    expect(accepted.idleExpiresAt).not.toBe(firstIdle);
    expect(accepted.idleExpiresAt.toISOString()).toBe(
      "2026-08-01T01:00:00.000Z",
    );
    expect(accepted.absoluteExpiresAt).not.toBe(firstAbsolute);
    expect(accepted.absoluteExpiresAt.toISOString()).toBe(
      "2026-08-08T00:00:00.500Z",
    );
    expect(accepted.sessionCookie).toEqual(cookie);
  });
});

describe("InvitationRepository cleanup and error classification", () => {
  it.each(["BEGIN", "SET LOCAL search_path = pg_catalog", "SELECT"])(
    "rolls back and releases after a %s failure",
    async (statement) => {
      const marker = `${statement}-${secretMarker}`;
      const events: InvitationSecurityEvent[] = [];
      const ring = keyRing();
      const client = new FakeClient({
        selectResult: issueRow(),
        failure: { statement, error: new Error(marker) },
      });
      const error = await capturedError(
        repository({
          client,
          ring,
          events,
          uuidValues: [invitationId, auditId],
        }).issueInvitation(issueInput(ring)),
      );

      expect(error).toBeInstanceOf(OperationInternalError);
      expect(error).toMatchObject({
        outcome: "not_committed",
        retrySafe: false,
      });
      expect(render(error)).not.toContain(marker);
      expect(client.calls.at(-1)?.text).toBe("ROLLBACK");
      expect(client.releases).toEqual([undefined]);
      expect(events).toEqual([{ requestId, reason: "internal_fault" }]);
    },
  );

  it.each(["P1001", "P1002", "23505"])(
    "classifies COMMIT acknowledgement loss (%s) as indeterminate and never retries",
    async (code) => {
      const events: InvitationSecurityEvent[] = [];
      const ring = keyRing();
      const client = new FakeClient({
        selectResult: issueRow(),
        failure: {
          statement: "COMMIT",
          error: { code, message: secretMarker },
        },
      });
      const connectedPool = pool(client);
      const repo = repository({
        client,
        ring,
        events,
        uuidValues: [invitationId, auditId],
        customPool: connectedPool,
      });
      const error = await capturedError(repo.issueInvitation(issueInput(ring)));

      expect(error).toBeInstanceOf(OperationInternalError);
      expect(error).toMatchObject({
        code: "internal_error",
        outcome: "commit_indeterminate",
        retrySafe: false,
      });
      expect(render(error)).not.toContain(secretMarker);
      expect(client.calls.map((call) => call.text)).not.toContain("ROLLBACK");
      expect(client.releases).toEqual([true]);
      expect(connectedPool.connect).toHaveBeenCalledOnce();
      expect(events).toEqual([{ requestId, reason: "internal_fault" }]);
    },
  );

  it.each([
    "connect",
    "BEGIN",
    "SET LOCAL search_path = pg_catalog",
    "validation",
    "ROLLBACK",
    "release",
  ])(
    "never treats P1001/P1002 from the %s stage as operation authority",
    async (stage) => {
      for (const code of ["P1001", "P1002"] as const) {
        const databaseError = { code, marker: secretMarker };
        const ring = keyRing();
        let client = new FakeClient({ selectResult: issueRow() });
        let customPool: PgCompatiblePool | undefined;
        if (stage === "connect") {
          customPool = {
            connect: async () => {
              throw databaseError;
            },
          };
        } else if (stage === "validation") {
          client = new FakeClient({
            selectResult: new Proxy(issueRow(), {
              getOwnPropertyDescriptor() {
                throw databaseError;
              },
            }),
          });
        } else if (stage === "ROLLBACK") {
          client = new FakeClient({
            selectResult: issueRow(),
            failure: { statement: "BEGIN", error: new Error("begin") },
            rollbackFailure: databaseError,
          });
        } else if (stage === "release") {
          client = new FakeClient({
            selectResult: issueRow(),
            failure: { statement: "BEGIN", error: new Error("begin") },
            releaseFailure: databaseError,
          });
        } else {
          client = new FakeClient({
            selectResult: issueRow(),
            failure: { statement: stage, error: databaseError },
          });
        }

        const error = await capturedError(
          repository({
            client,
            ring,
            customPool,
            uuidValues: [invitationId, auditId],
          }).issueInvitation(issueInput(ring)),
        );
        expect(error).toBeInstanceOf(OperationInternalError);
        expect(error).toMatchObject({ outcome: "not_committed" });
        expect(render(error)).not.toContain(secretMarker);
      }
    },
  );

  it("destructively releases when rollback fails without leaking either failure", async () => {
    const ring = keyRing();
    const client = new FakeClient({
      selectResult: issueRow(),
      failure: {
        statement: "BEGIN",
        error: new Error(`begin-${secretMarker}`),
      },
      rollbackFailure: new Error(`rollback-${secretMarker}`),
    });
    const error = await capturedError(
      repository({
        client,
        ring,
        uuidValues: [invitationId, auditId],
      }).issueInvitation(issueInput(ring)),
    );

    expect(error).toBeInstanceOf(OperationInternalError);
    expect(render(error)).not.toContain(secretMarker);
    expect(client.calls.map((call) => call.text)).toEqual([
      "BEGIN",
      "ROLLBACK",
    ]);
    expect(client.releases).toEqual([true]);
  });

  it("normalizes connect failures but keeps committed issue authoritative after release failure", async () => {
    const ring = keyRing();
    const connectMarker = `connect-${secretMarker}`;
    const connectError = await capturedError(
      repository({
        client: new FakeClient({ selectResult: issueRow() }),
        ring,
        uuidValues: [invitationId, auditId],
        customPool: {
          connect: async () => {
            throw new Error(connectMarker);
          },
        },
      }).issueInvitation(issueInput(ring)),
    );
    expect(connectError).toBeInstanceOf(OperationInternalError);
    expect(render(connectError)).not.toContain(connectMarker);

    const releaseMarker = `release-${secretMarker}`;
    const client = new FakeClient({
      selectResult: issueRow(),
      releaseFailure: new Error(releaseMarker),
    });
    const events: InvitationSecurityEvent[] = [];
    await expect(
      repository({
        client,
        ring,
        events,
        uuidValues: [invitationId, auditId],
      }).issueInvitation(issueInput(ring)),
    ).resolves.toMatchObject({ invitationId });
    expect(client.calls.at(-1)?.text).toBe("COMMIT");
    expect(client.releases).toEqual([undefined, true]);
    expect(events).toEqual([]);
  });

  it("keeps committed acceptance authoritative after release failure", async () => {
    const ring = keyRing();
    const invite = ring.issue("invite");
    const client = new FakeClient({
      selectResult: acceptRow(),
      releaseFailure: new Error(`accept-release-${secretMarker}`),
    });
    await expect(
      repository({
        client,
        ring,
        uuidValues: [
          proposedUserId,
          proposedMembershipId,
          proposedSessionId,
          acceptAuditId,
        ],
      }).acceptInvitation({
        requestId,
        inviteToken: invite.wireValue,
        principal: principal(),
      }),
    ).resolves.toMatchObject({ sessionId: proposedSessionId });
    expect(client.calls.at(-1)?.text).toBe("COMMIT");
    expect(client.releases).toEqual([undefined, true]);
  });

  it("observes asynchronous normal and destructive release failures after COMMIT", async () => {
    const ring = keyRing();
    const client = new FakeClient({
      selectResult: issueRow(),
      releaseResult: (destroy) =>
        destroy === true
          ? {
              then(_resolve: unknown, reject: (error: unknown) => void) {
                reject(new Error(`destructive-${secretMarker}`));
              },
            }
          : Promise.reject(new Error(`normal-${secretMarker}`)),
    });
    const result = await repository({
      client,
      ring,
      uuidValues: [invitationId, auditId],
    }).issueInvitation(issueInput(ring));

    expect(result.invitationId).toBe(invitationId);
    await vi.waitFor(() => expect(client.releases).toEqual([undefined, true]));
  });

  it("destructively releases after successful rollback plus asynchronous release failure", async () => {
    const ring = keyRing();
    const client = new FakeClient({
      selectResult: issueRow(),
      failure: { statement: "BEGIN", error: new Error(secretMarker) },
      releaseResult: (destroy) =>
        destroy === true
          ? Promise.reject(new Error(`destructive-${secretMarker}`))
          : {
              then(_resolve: unknown, reject: (error: unknown) => void) {
                reject(new Error(`normal-${secretMarker}`));
              },
            },
    });
    const error = await capturedError(
      repository({
        client,
        ring,
        uuidValues: [invitationId, auditId],
      }).issueInvitation(issueInput(ring)),
    );

    expect(error).toMatchObject({ outcome: "not_committed" });
    await vi.waitFor(() => expect(client.releases).toEqual([undefined, true]));
    expect(render(error)).not.toContain(secretMarker);
  });

  it("does not await a never-settling cleanup thenable", async () => {
    const ring = keyRing();
    const client = new FakeClient({
      selectResult: issueRow(),
      releaseResult: () => ({ then() {} }),
    });
    const result = await repository({
      client,
      ring,
      uuidValues: [invitationId, auditId],
    }).issueInvitation(issueInput(ring));

    expect(result.invitationId).toBe(invitationId);
    expect(client.releases).toEqual([undefined]);
  });

  it("uses captured Promise cleanup intrinsics after post-load poisoning", async () => {
    const ring = keyRing();
    const resolveDescriptor = intrinsicGetOwnPropertyDescriptor(
      Promise,
      "resolve",
    )!;
    const thenDescriptor = intrinsicGetOwnPropertyDescriptor(
      Promise.prototype,
      "then",
    )!;
    let thenPoisoned = false;
    let poisonedThenCalls = 0;
    const client = new FakeClient({
      selectResult: issueRow(),
      releaseResult: (destroy) => {
        if (destroy === true) {
          return Promise.reject(new Error(secretMarker));
        }
        intrinsicDefineProperty(Promise.prototype, "then", {
          ...thenDescriptor,
          value: () => {
            poisonedThenCalls += 1;
            throw new Error(secretMarker);
          },
        });
        thenPoisoned = true;
        queueMicrotask(() => {
          intrinsicDefineProperty(Promise.prototype, "then", thenDescriptor);
          thenPoisoned = false;
        });
        return Promise.reject(new Error(secretMarker));
      },
    });
    const repo = repository({
      client,
      ring,
      uuidValues: [invitationId, auditId],
    });
    const input = issueInput(ring);
    let result: unknown;
    try {
      intrinsicDefineProperty(Promise, "resolve", {
        ...resolveDescriptor,
        value: () => {
          throw new Error(secretMarker);
        },
      });
      result = await repo.issueInvitation(input);
      await 0;
      await 0;
    } finally {
      if (thenPoisoned) {
        intrinsicDefineProperty(Promise.prototype, "then", thenDescriptor);
      }
      intrinsicDefineProperty(Promise, "resolve", resolveDescriptor);
    }

    expect(result).toMatchObject({ invitationId });
    expect(client.releases).toEqual([undefined, true]);
    expect(poisonedThenCalls).toBe(0);
  });

  it("destructively releases a hostile malformed client before any statement", async () => {
    const ring = keyRing();
    const releases: Array<boolean | undefined> = [];
    const malformedClient = {
      get query(): never {
        throw new Error(secretMarker);
      },
      release(destroy?: boolean) {
        releases.push(destroy);
      },
    };
    const error = await capturedError(
      repository({
        client: new FakeClient({ selectResult: issueRow() }),
        ring,
        uuidValues: [invitationId, auditId],
        customPool: {
          connect: async () => malformedClient as never,
        },
      }).issueInvitation(issueInput(ring)),
    );

    expect(error).toBeInstanceOf(OperationInternalError);
    expect(render(error)).not.toContain(secretMarker);
    expect(releases).toEqual([true]);
  });

  it.each([
    [{ code: "P1001" }, OperationDeniedError, "authority_invalid"],
    [{ code: "P1002" }, OperationConflictError, "identifier_conflict"],
  ] as const)(
    "maps exact own-data SQLSTATE only",
    async (databaseError, expected, reason) => {
      const events: InvitationSecurityEvent[] = [];
      const ring = keyRing();
      const client = new FakeClient({
        selectResult: issueRow(),
        failure: { statement: "SELECT", error: databaseError },
      });
      const error = await capturedError(
        repository({
          client,
          ring,
          events,
          uuidValues: [invitationId, auditId],
        }).issueInvitation(issueInput(ring)),
      );
      expect(error).toBeInstanceOf(expected);
      expect(events).toEqual([{ requestId, reason }]);
    },
  );

  it("uses accept-specific state-invalid normalization", async () => {
    const events: InvitationSecurityEvent[] = [];
    const ring = keyRing();
    const invite = ring.issue("invite");
    const client = new FakeClient({
      selectResult: acceptRow(),
      failure: { statement: "SELECT", error: { code: "P1001" } },
    });
    await expect(
      repository({
        client,
        ring,
        events,
        uuidValues: [
          proposedUserId,
          proposedMembershipId,
          proposedSessionId,
          acceptAuditId,
        ],
      }).acceptInvitation({
        requestId,
        inviteToken: invite.wireValue,
        principal: principal(),
      }),
    ).rejects.toBeInstanceOf(OperationDeniedError);
    expect(events).toEqual([{ requestId, reason: "state_invalid" }]);
  });

  it.each([
    ["inherited", Object.assign(Object.create({ code: "P1001" }), {})],
    ["getter", Object.defineProperty({}, "code", { get: () => "P1001" })],
    ["message only", new Error("P1001 dasher_denied")],
    ["lookalike", { code: new String("P1001") }],
    ["wrong case", { code: "p1001" }],
    ["unexpected", { code: "23505", constraint: secretMarker }],
    [
      "proxy",
      new Proxy(
        {},
        {
          getOwnPropertyDescriptor() {
            throw new Error(secretMarker);
          },
        },
      ),
    ],
  ])("keeps %s code shapes internal", async (_name, databaseError) => {
    const ring = keyRing();
    const client = new FakeClient({
      selectResult: issueRow(),
      failure: { statement: "SELECT", error: databaseError },
    });
    const error = await capturedError(
      repository({
        client,
        ring,
        uuidValues: [invitationId, auditId],
      }).issueInvitation(issueInput(ring)),
    );
    expect(error).toBeInstanceOf(OperationInternalError);
    expect(render(error)).not.toContain(secretMarker);
  });

  it("does not let a throwing or rejecting sink alter classification", async () => {
    for (const sink of [
      () => {
        throw new Error(secretMarker);
      },
      () => Promise.reject(new Error(secretMarker)),
    ]) {
      const ring = keyRing();
      const client = new FakeClient({
        selectResult: issueRow(),
        failure: { statement: "SELECT", error: { code: "P1002" } },
      });
      await expect(
        repository({
          client,
          ring,
          sink,
          uuidValues: [invitationId, auditId],
        }).issueInvitation(issueInput(ring)),
      ).rejects.toBeInstanceOf(OperationConflictError);
    }
  });
});

describe("InvitationRepository validation and snapshots", () => {
  it("retains the module-snapshotted randomUUID capability for every generated identifier", async () => {
    const mutableCrypto = crypto as typeof crypto;
    const originalRandomUuid = mutableCrypto.randomUUID;
    const baselineUuid = originalRandomUuid();
    const maliciousUuid = "deadbeef-dead-4bad-8bad-deadbeefdead";
    const ring = keyRing();
    const input = issueInput(ring);
    const events: InvitationSecurityEvent[] = [];
    let maliciousCalls = 0;
    const issueClient = new FakeClient({
      selectResult: (_text, values) => issueRow({ invitation_id: values?.[0] }),
    });
    const acceptClient = new FakeClient({
      selectResult: (_text, values) =>
        acceptRow({
          user_id: values?.[6],
          membership_id: values?.[7],
          session_id: values?.[8],
        }),
    });
    let fallbackConnects = 0;
    let issued:
      Awaited<ReturnType<InvitationRepository["issueInvitation"]>> | undefined;
    let accepted:
      Awaited<ReturnType<InvitationRepository["acceptInvitation"]>> | undefined;
    let fallbackError: unknown;
    try {
      mutableCrypto.randomUUID = (() => {
        maliciousCalls += 1;
        return maliciousUuid;
      }) as typeof mutableCrypto.randomUUID;
      syncBuiltinESMExports();

      const issueRepository = new InvitationRepository({
        pool: pool(issueClient),
        keyRing: ring,
        deploymentRevision: "task6-repository",
        securityEventSink: () => undefined,
      });
      issued = await issueRepository.issueInvitation(input);
      const acceptRepository = new InvitationRepository({
        pool: pool(acceptClient),
        keyRing: ring,
        deploymentRevision: "task6-repository",
        securityEventSink: () => undefined,
      });
      accepted = await acceptRepository.acceptInvitation({
        requestId,
        inviteToken: issued.inviteToken,
        principal: principal(),
      });
      const fallbackRepository = new InvitationRepository({
        pool: {
          connect: async () => {
            fallbackConnects += 1;
            return new FakeClient({ selectResult: issueRow() });
          },
        },
        keyRing: ring,
        deploymentRevision: "task6-repository",
        securityEventSink: (event) => {
          events.push(event);
        },
      });
      try {
        await fallbackRepository.issueInvitation({
          ...input,
          requestId: `invalid-${secretMarker}`,
        });
      } catch (error) {
        fallbackError = error;
      }
    } finally {
      mutableCrypto.randomUUID = originalRandomUuid;
      syncBuiltinESMExports();
    }

    const issueValues = issueClient.calls[2]?.values;
    const acceptValues = acceptClient.calls[2]?.values;
    const generatedOperationIds = [
      issueValues?.[0],
      issueValues?.[5],
      acceptValues?.[6],
      acceptValues?.[7],
      acceptValues?.[8],
      acceptValues?.[13],
    ];
    expect(baselineUuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
    );
    expect(generatedOperationIds).toHaveLength(6);
    expect(new Set(generatedOperationIds).size).toBe(6);
    for (const generatedId of generatedOperationIds) {
      expect(generatedId).toEqual(expect.any(String));
      expect(generatedId).not.toBe(maliciousUuid);
    }
    expect(issued?.invitationId).toBe(issueValues?.[0]);
    expect(accepted).toMatchObject({
      userId: acceptValues?.[6],
      membershipId: acceptValues?.[7],
      sessionId: acceptValues?.[8],
    });
    expect(fallbackError).toBeInstanceOf(OperationDeniedError);
    expect(fallbackConnects).toBe(0);
    expect(events).toHaveLength(1);
    expect(events[0]?.requestId).not.toBe(maliciousUuid);
    expect(events[0]?.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
    );
    expect(maliciousCalls).toBe(0);
    expect(render([fallbackError, events])).not.toContain(secretMarker);
  });

  it("reads requestId exactly once and retains it for later getter failure events", async () => {
    const ring = keyRing();
    const current = issueInput(ring);
    const events: InvitationSecurityEvent[] = [];
    const connectedPool = pool(new FakeClient({ selectResult: issueRow() }));
    let requestReads = 0;
    const input = {
      get requestId() {
        requestReads += 1;
        return requestReads === 1 ? requestId : secretMarker;
      },
      get email(): never {
        throw new Error(secretMarker);
      },
      role: current.role,
      currentSessionToken: current.currentSessionToken,
      currentCsrfValue: current.currentCsrfValue,
    };
    const error = await capturedError(
      repository({
        client: new FakeClient({ selectResult: issueRow() }),
        ring,
        events,
        customPool: connectedPool,
      }).issueInvitation(input),
    );

    expect(error).toBeInstanceOf(OperationDeniedError);
    expect(requestReads).toBe(1);
    expect(events).toEqual([{ requestId, reason: "input_invalid" }]);
    expect(connectedPool.connect).not.toHaveBeenCalled();
    expect(render([error, events])).not.toContain(secretMarker);
  });

  it("reads a trapping requestId once and emits one bounded generated fallback", async () => {
    const ring = keyRing();
    const events: InvitationSecurityEvent[] = [];
    const connectedPool = pool(new FakeClient({ selectResult: issueRow() }));
    let requestReads = 0;
    const input = {
      get requestId(): never {
        requestReads += 1;
        throw new Error(secretMarker);
      },
      email: "invited@example.test",
      role: "editor" as const,
      currentSessionToken: ring.issue("session").wireValue,
      currentCsrfValue: ring.issue("csrf").wireValue,
    };
    const error = await capturedError(
      repository({
        client: new FakeClient({ selectResult: issueRow() }),
        ring,
        events,
        customPool: connectedPool,
        uuidValues: [invitationId],
      }).issueInvitation(input),
    );

    expect(error).toBeInstanceOf(OperationDeniedError);
    expect(requestReads).toBe(1);
    expect(events).toEqual([
      { requestId: invitationId, reason: "input_invalid" },
    ]);
    expect(connectedPool.connect).not.toHaveBeenCalled();
    expect(render([error, events])).not.toContain(secretMarker);
  });

  it("uses captured validation and freezing intrinsics after bounded post-load poisoning", async () => {
    const ring = keyRing();
    const events: InvitationSecurityEvent[] = [];
    let connects = 0;
    const repo = new InvitationRepository({
      pool: {
        connect: async () => {
          connects += 1;
          return new FakeClient({ selectResult: issueRow() });
        },
      },
      keyRing: ring,
      deploymentRevision: "task6-repository",
      securityEventSink: (event) => {
        events.push(event);
      },
      uuidSource: uuids([invitationId]),
    });
    const regexpDescriptor = intrinsicGetOwnPropertyDescriptor(
      RegExp.prototype,
      "test",
    )!;
    const charCodeDescriptor = intrinsicGetOwnPropertyDescriptor(
      String.prototype,
      "charCodeAt",
    )!;
    const freezeDescriptor = intrinsicGetOwnPropertyDescriptor(
      Object,
      "freeze",
    )!;
    const getOwnDescriptor = intrinsicGetOwnPropertyDescriptor(
      Object,
      "getOwnPropertyDescriptor",
    )!;
    const getPrototypeDescriptor = intrinsicGetOwnPropertyDescriptor(
      Object,
      "getPrototypeOf",
    )!;
    const applyDescriptor = intrinsicGetOwnPropertyDescriptor(
      Reflect,
      "apply",
    )!;
    let operationError: unknown;
    let deploymentError: unknown;
    let normalizedEmail: string | undefined;
    let verifiedIssuer: string | undefined;
    let invalidEmailError: unknown;
    let invalidIdentityError: unknown;
    try {
      intrinsicDefineProperty(RegExp.prototype, "test", {
        ...regexpDescriptor,
        value: () => true,
      });
      intrinsicDefineProperty(String.prototype, "charCodeAt", {
        ...charCodeDescriptor,
        value: () => 0x61,
      });
      intrinsicDefineProperty(Object, "freeze", {
        ...freezeDescriptor,
        value: () => {
          throw new Error(secretMarker);
        },
      });
      intrinsicDefineProperty(Object, "getOwnPropertyDescriptor", {
        ...getOwnDescriptor,
        value: () => {
          throw new Error(secretMarker);
        },
      });
      intrinsicDefineProperty(Object, "getPrototypeOf", {
        ...getPrototypeDescriptor,
        value: () => {
          throw new Error(secretMarker);
        },
      });
      intrinsicDefineProperty(Reflect, "apply", {
        ...applyDescriptor,
        value: () => {
          throw new Error(secretMarker);
        },
      });

      normalizedEmail = normalizeEmailAddress("INVITED@EXAMPLE.TEST");
      verifiedIssuer = createVerifiedPrincipalFromServerVerification({
        issuer: "https://issuer.example/immutable",
        subject: "immutable-subject",
        emailVerified: true,
        verifiedEmail: "INVITED@EXAMPLE.TEST",
      }).issuer;
      try {
        normalizeEmailAddress(`bad\n${secretMarker}@example.test`);
      } catch (error) {
        invalidEmailError = error;
      }
      try {
        createVerifiedPrincipalFromServerVerification({
          issuer: `bad\n${secretMarker}`,
          subject: "immutable-subject",
          emailVerified: true,
          verifiedEmail: "invited@example.test",
        });
      } catch (error) {
        invalidIdentityError = error;
      }
      try {
        new InvitationRepository({
          pool: {
            connect: async () => new FakeClient({ selectResult: issueRow() }),
          },
          keyRing: ring,
          deploymentRevision: " leading",
          securityEventSink: () => undefined,
        });
      } catch (error) {
        deploymentError = error;
      }
      try {
        await repo.issueInvitation({
          ...issueInput(ring),
          requestId: secretMarker,
        });
      } catch (error) {
        operationError = error;
      }
    } finally {
      intrinsicDefineProperty(RegExp.prototype, "test", regexpDescriptor);
      intrinsicDefineProperty(
        String.prototype,
        "charCodeAt",
        charCodeDescriptor,
      );
      intrinsicDefineProperty(Object, "freeze", freezeDescriptor);
      intrinsicDefineProperty(
        Object,
        "getOwnPropertyDescriptor",
        getOwnDescriptor,
      );
      intrinsicDefineProperty(Object, "getPrototypeOf", getPrototypeDescriptor);
      intrinsicDefineProperty(Reflect, "apply", applyDescriptor);
    }

    expect(normalizedEmail).toBe("invited@example.test");
    expect(verifiedIssuer).toBe("https://issuer.example/immutable");
    expect(invalidEmailError).toBeInstanceOf(Error);
    expect(invalidIdentityError).toBeInstanceOf(Error);
    expect(deploymentError).toBeInstanceOf(OperationInternalError);
    expect(operationError).toBeInstanceOf(OperationDeniedError);
    expect(connects).toBe(0);
    expect(events).toEqual([
      { requestId: invitationId, reason: "input_invalid" },
    ]);
    expect(
      render([
        invalidEmailError,
        invalidIdentityError,
        deploymentError,
        operationError,
        events,
      ]),
    ).not.toContain(secretMarker);
  });
  it.each(["issue", "accept"] as const)(
    "classifies repository %s secret issuance failures as internal before connect",
    async (operation) => {
      const marker = `repository-random-${operation}-${secretMarker}`;
      const goodRing = keyRing();
      const failingRing = keyRing(() => {
        throw new Error(marker);
      });
      const client = new FakeClient({
        selectResult: operation === "issue" ? issueRow() : acceptRow(),
      });
      const customPool = pool(client);
      const events: InvitationSecurityEvent[] = [];
      const repo = repository({
        client,
        ring: failingRing,
        customPool,
        events,
        uuidValues:
          operation === "issue"
            ? [invitationId, auditId]
            : [
                proposedUserId,
                proposedMembershipId,
                proposedSessionId,
                acceptAuditId,
              ],
      });
      const error = await capturedError(
        operation === "issue"
          ? repo.issueInvitation(issueInput(goodRing))
          : repo.acceptInvitation({
              requestId,
              inviteToken: goodRing.issue("invite").wireValue,
              principal: principal(),
            }),
      );

      expect(error).toBeInstanceOf(OperationInternalError);
      expect(render(error)).not.toContain(marker);
      expect(customPool.connect).not.toHaveBeenCalled();
      expect(events).toEqual([{ requestId, reason: "internal_fault" }]);
      expect(render(events)).not.toContain(marker);
    },
  );

  it("denies malformed inputs, roles, email, and token kinds before connect", async () => {
    const ring = keyRing();
    const current = issueInput(ring);
    const cases = [
      { ...current, requestId: "not-a-uuid" },
      { ...current, email: " invited@example.test" },
      { ...current, role: "owner" },
      { ...current, currentSessionToken: current.currentCsrfValue },
      { ...current, currentCsrfValue: current.currentSessionToken },
      { ...current, currentSessionToken: `${current.currentSessionToken}x` },
    ];
    for (const candidate of cases) {
      const client = new FakeClient({ selectResult: issueRow() });
      const customPool = pool(client);
      await expect(
        repository({
          client,
          ring,
          customPool,
          uuidValues: [invitationId, auditId],
        }).issueInvitation(candidate as never),
      ).rejects.toBeInstanceOf(OperationDeniedError);
      expect(customPool.connect).not.toHaveBeenCalled();
    }
  });

  it.each([
    ["retired", `i1.3.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`],
    ["unknown", `i1.4.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`],
    ["wrong kind", `s1.2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`],
    ["malformed", "i1.2.not-a-canonical-secret"],
  ])("denies %s invite tokens before connect", async (_name, token) => {
    const ring = keyRing();
    const client = new FakeClient({ selectResult: acceptRow() });
    const customPool = pool(client);
    await expect(
      repository({ client, ring, customPool }).acceptInvitation({
        requestId,
        inviteToken: token,
        principal: principal(),
      }),
    ).rejects.toBeInstanceOf(OperationDeniedError);
    expect(customPool.connect).not.toHaveBeenCalled();
  });

  it("accepts a previous active invite key version through the exact lookup", async () => {
    const previousIssuer = new SecretKeyRing(
      {
        currentVersion: 1,
        verificationKeys: [{ version: 1, key: bytes(10) }],
      },
      { randomBytes: () => bytes(90) },
    );
    const invite = previousIssuer.issue("invite");
    const ring = keyRing();
    const client = new FakeClient({ selectResult: acceptRow() });
    await expect(
      repository({
        client,
        ring,
        uuidValues: [
          proposedUserId,
          proposedMembershipId,
          proposedSessionId,
          acceptAuditId,
        ],
      }).acceptInvitation({
        requestId,
        inviteToken: invite.wireValue,
        principal: principal(),
      }),
    ).resolves.toMatchObject({ sessionId: proposedSessionId });
    expect(client.calls[2]?.values?.[0]).toBe(1);
  });

  it.each([
    ["noncanonical", ["NOT-A-UUID"]],
    ["bounded collisions", Array.from({ length: 16 }, () => requestId)],
  ])("rejects %s generated UUIDs before connect", async (_name, uuidValues) => {
    const ring = keyRing();
    const client = new FakeClient({ selectResult: issueRow() });
    const customPool = pool(client);
    await expect(
      repository({ client, ring, customPool, uuidValues }).issueInvitation(
        issueInput(ring),
      ),
    ).rejects.toBeInstanceOf(OperationInternalError);
    expect(customPool.connect).not.toHaveBeenCalled();
  });

  it("rejects unbranded and hostile proxy principals before connect", async () => {
    const marker = `principal-proxy-${secretMarker}`;
    const ring = keyRing();
    const invite = ring.issue("invite");
    const client = new FakeClient({ selectResult: acceptRow() });
    const customPool = pool(client);
    const events: InvitationSecurityEvent[] = [];
    const candidates = [
      {
        issuer: "issuer",
        subject: "subject",
        emailVerified: true,
        normalizedVerifiedEmail: "invited@example.test",
      },
      new Proxy(principal(), {
        getPrototypeOf() {
          throw new Error(marker);
        },
      }),
    ];
    for (const candidate of candidates) {
      const error = await capturedError(
        repository({ client, ring, customPool, events }).acceptInvitation({
          requestId,
          inviteToken: invite.wireValue,
          principal: candidate as never,
        }),
      );
      expect(error).toBeInstanceOf(OperationDeniedError);
      expect(render(error)).not.toContain(marker);
    }
    expect(customPool.connect).not.toHaveBeenCalled();
    expect(render(events)).not.toContain(marker);
    expect(() =>
      createVerifiedPrincipalFromServerVerification({
        issuer: "issuer",
        subject: "subject",
        emailVerified: false as never,
        verifiedEmail: "invited@example.test",
      }),
    ).toThrow();
  });

  it("snapshots config and operation inputs before connect", async () => {
    const ring = keyRing();
    const input = issueInput(ring);
    const client = new FakeClient({ selectResult: issueRow() });
    let allowConnect!: () => void;
    const connectBarrier = new Promise<void>((resolve) => {
      allowConnect = resolve;
    });
    const mutableConfig = {
      pool: {
        connect: async () => {
          await connectBarrier;
          return client;
        },
      },
      keyRing: ring,
      deploymentRevision: "fixed-deployment",
      securityEventSink: () => undefined,
      uuidSource: uuids([invitationId, auditId]),
    };
    const repo = new InvitationRepository(mutableConfig);
    mutableConfig.deploymentRevision = `mutated-${secretMarker}`;
    const operation = repo.issueInvitation(input);
    input.email = "changed@example.test";
    allowConnect();
    const result = await operation;

    expect(result.invitationId).toBe(invitationId);
    expect(client.calls[2]?.values?.[1]).toBe("invited@example.test");
    expect(client.calls[2]?.values?.[11]).toBe("fixed-deployment");
  });

  it("captures each config seam once before later getters mutate earlier seams", async () => {
    const marker = `cross-getter-${secretMarker}`;
    const ring = keyRing();
    const input = issueInput(ring);
    const client = new FakeClient({ selectResult: issueRow() });
    const originalConnect = vi.fn(async () => client);
    const swappedConnect = vi.fn(async () => {
      throw new Error(marker);
    });
    const capturedEvents: InvitationSecurityEvent[] = [];
    const swappedEvents: InvitationSecurityEvent[] = [];
    const originalSink = (event: InvitationSecurityEvent) => {
      capturedEvents.push(event);
    };
    const swappedSink = (event: InvitationSecurityEvent) => {
      swappedEvents.push(event);
    };
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
        return "captured-deployment";
      },
      get securityEventSink() {
        reads.push("securityEventSink");
        return originalSink;
      },
      get uuidSource() {
        reads.push("uuidSource");
        Object.defineProperty(config, "securityEventSink", {
          configurable: true,
          value: swappedSink,
        });
        return uuids([invitationId, auditId]);
      },
    };
    const repo = new InvitationRepository(config);
    const result = await repo.issueInvitation(input);

    expect(result.invitationId).toBe(invitationId);
    expect(reads).toEqual([
      "pool",
      "keyRing",
      "deploymentRevision",
      "securityEventSink",
      "uuidSource",
    ]);
    expect(originalConnect).toHaveBeenCalledOnce();
    expect(swappedConnect).not.toHaveBeenCalled();
    expect(client.calls[2]?.values?.[11]).toBe("captured-deployment");
    expect(capturedEvents).toEqual([]);
    expect(swappedEvents).toEqual([]);
  });

  it("uses module-captured key-ring methods after exported prototype mutation", async () => {
    const marker = `prototype-${secretMarker}`;
    const issueDescriptor = Object.getOwnPropertyDescriptor(
      SecretKeyRing.prototype,
      "issue",
    )!;
    const verifyDescriptor = Object.getOwnPropertyDescriptor(
      SecretKeyRing.prototype,
      "verify",
    )!;
    const hasInstanceDescriptor = Object.getOwnPropertyDescriptor(
      SecretKeyRing,
      Symbol.hasInstance,
    );
    const ring = keyRing();
    const issueInputSnapshot = issueInput(ring);
    const invite = ring.issue("invite");
    try {
      Object.defineProperty(SecretKeyRing.prototype, "issue", {
        ...issueDescriptor,
        value() {
          throw new Error(marker);
        },
      });
      Object.defineProperty(SecretKeyRing.prototype, "verify", {
        ...verifyDescriptor,
        value() {
          throw new Error(marker);
        },
      });
      Object.defineProperty(SecretKeyRing, Symbol.hasInstance, {
        configurable: true,
        value() {
          throw new Error(marker);
        },
      });

      const issueClient = new FakeClient({ selectResult: issueRow() });
      await expect(
        repository({
          client: issueClient,
          ring,
          uuidValues: [invitationId, auditId],
        }).issueInvitation(issueInputSnapshot),
      ).resolves.toMatchObject({ invitationId });

      const acceptClient = new FakeClient({ selectResult: acceptRow() });
      await expect(
        repository({
          client: acceptClient,
          ring,
          uuidValues: [
            proposedUserId,
            proposedMembershipId,
            proposedSessionId,
            acceptAuditId,
          ],
        }).acceptInvitation({
          requestId,
          inviteToken: invite.wireValue,
          principal: principal(),
        }),
      ).resolves.toMatchObject({ sessionId: proposedSessionId });
    } finally {
      Object.defineProperty(SecretKeyRing.prototype, "issue", issueDescriptor);
      Object.defineProperty(
        SecretKeyRing.prototype,
        "verify",
        verifyDescriptor,
      );
      if (hasInstanceDescriptor === undefined) {
        Reflect.deleteProperty(SecretKeyRing, Symbol.hasInstance);
      } else {
        Object.defineProperty(
          SecretKeyRing,
          Symbol.hasInstance,
          hasInstanceDescriptor,
        );
      }
    }
  });

  it.each([
    "",
    " leading",
    "trailing ",
    "control\nrevision",
    "\u0085",
    "x".repeat(65),
    "😀".repeat(65),
  ])(
    "rejects invalid fixed deployment revision before use",
    (deploymentRevision) => {
      expect(() =>
        repository({
          client: new FakeClient({ selectResult: issueRow() }),
          deploymentRevision,
        }),
      ).toThrowError(OperationInternalError);
    },
  );

  it("normalizes hostile configuration getters without retaining their marker", () => {
    const marker = `config-${secretMarker}`;
    let error: unknown;
    try {
      new InvitationRepository(
        new Proxy(
          {},
          {
            get() {
              throw new Error(marker);
            },
          },
        ) as never,
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(OperationInternalError);
    expect(render(error)).not.toContain(marker);
  });

  it("rejects a proxy lookalike key ring during configuration snapshot", () => {
    const marker = `key-ring-${secretMarker}`;
    const lookalike = new Proxy(keyRing(), {
      get(target, property, receiver) {
        if (property === "verify") {
          throw new Error(marker);
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const customPool = pool(new FakeClient({ selectResult: issueRow() }));
    let error: unknown;
    try {
      new InvitationRepository({
        pool: customPool,
        keyRing: lookalike,
        deploymentRevision: "task6-repository",
        securityEventSink: () => undefined,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(OperationInternalError);
    expect(render(error)).not.toContain(marker);
    expect(customPool.connect).not.toHaveBeenCalled();
  });

  it.each([
    [{ rowCount: 0, rows: [] }, "cardinality"],
    [{ rowCount: 1, rows: [] }, "row mismatch"],
    [issueRow({ invitation_id: "NOT-CANONICAL" }), "UUID"],
    [issueRow({ expires_at: "2026-08-07" }), "timestamp"],
  ] as const)("rolls back malformed %s result", async (selectResult, name) => {
    expect(name).not.toBe("");
    const ring = keyRing();
    const client = new FakeClient({ selectResult });
    await expect(
      repository({
        client,
        ring,
        uuidValues: [invitationId, auditId],
      }).issueInvitation(issueInput(ring)),
    ).rejects.toBeInstanceOf(OperationInternalError);
    expect(client.calls.at(-1)?.text).toBe("ROLLBACK");
  });

  it("reads successful result array length and row index exactly once", async () => {
    const ring = keyRing();
    const row = issueRow().rows[0];
    let lengthReads = 0;
    let rowReads = 0;
    const rows = new Proxy([row], {
      get(target, property, receiver) {
        if (property === "length") {
          lengthReads += 1;
        }
        if (property === "0") {
          rowReads += 1;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const client = new FakeClient({
      selectResult: { rowCount: 1, rows },
    });
    await expect(
      repository({
        client,
        ring,
        uuidValues: [invitationId, auditId],
      }).issueInvitation(issueInput(ring)),
    ).resolves.toMatchObject({ invitationId });
    expect(lengthReads).toBe(1);
    expect(rowReads).toBe(1);
  });

  it("normalizes hostile and revoked result-array traps with rollback", async () => {
    const marker = `result-array-${secretMarker}`;
    const row = issueRow().rows[0];
    const revoked = Proxy.revocable([row], {});
    revoked.revoke();
    const hostileRows: readonly unknown[] = [
      new Proxy([row], {
        get(target, property, receiver) {
          if (property === "length") {
            throw new Error(marker);
          }
          return Reflect.get(target, property, receiver);
        },
      }),
      new Proxy([row], {
        get(target, property, receiver) {
          if (property === "0") {
            throw new Error(marker);
          }
          return Reflect.get(target, property, receiver);
        },
      }),
      revoked.proxy,
    ];

    for (const rows of hostileRows) {
      const events: InvitationSecurityEvent[] = [];
      const ring = keyRing();
      const client = new FakeClient({
        selectResult: { rowCount: 1, rows: rows as readonly unknown[] },
      });
      const error = await capturedError(
        repository({
          client,
          ring,
          events,
          uuidValues: [invitationId, auditId],
        }).issueInvitation(issueInput(ring)),
      );
      expect(error).toBeInstanceOf(OperationInternalError);
      expect(render(error)).not.toContain(marker);
      expect(events).toEqual([{ requestId, reason: "internal_fault" }]);
      expect(render(events)).not.toContain(marker);
      expect(client.calls.at(-1)?.text).toBe("ROLLBACK");
    }
  });

  it("normalizes hostile result and timestamp prototype traps secret-free", async () => {
    const marker = `result-prototype-${secretMarker}`;
    const hostileResult = new Proxy(issueRow(), {
      getOwnPropertyDescriptor() {
        throw new Error(marker);
      },
    });
    const hostileDate = new Proxy(new Date("2026-08-07T00:00:00.000Z"), {
      getPrototypeOf() {
        throw new Error(marker);
      },
    });
    for (const selectResult of [
      hostileResult,
      issueRow({ expires_at: hostileDate }),
    ]) {
      const events: InvitationSecurityEvent[] = [];
      const ring = keyRing();
      const client = new FakeClient({ selectResult });
      const error = await capturedError(
        repository({
          client,
          ring,
          events,
          uuidValues: [invitationId, auditId],
        }).issueInvitation(issueInput(ring)),
      );
      expect(error).toBeInstanceOf(OperationInternalError);
      expect(render(error)).not.toContain(marker);
      expect(render(events)).not.toContain(marker);
      expect(client.calls.at(-1)?.text).toBe("ROLLBACK");
    }
  });

  it.each([
    { granted_role: "owner" },
    { authority_revision: "0" },
    { authority_revision: "01" },
    { authority_revision: "9".repeat(1_000_000) },
    { session_id: "20000000-0000-4000-8000-000000000099" },
    { database_now: new Date("2026-08-08T00:00:00.500Z") },
    { idle_expires_at: new Date("2026-08-09T00:00:00.500Z") },
  ])("rolls back malformed acceptance row %#", async (overrides) => {
    const ring = keyRing();
    const invite = ring.issue("invite");
    const client = new FakeClient({ selectResult: acceptRow(overrides) });
    await expect(
      repository({
        client,
        ring,
        uuidValues: [
          proposedUserId,
          proposedMembershipId,
          proposedSessionId,
          acceptAuditId,
        ],
      }).acceptInvitation({
        requestId,
        inviteToken: invite.wireValue,
        principal: principal(),
      }),
    ).rejects.toBeInstanceOf(OperationInternalError);
    expect(client.calls.at(-1)?.text).toBe("ROLLBACK");
  });

  it("emits exact frozen bounded events and secret-free typed errors", async () => {
    const events: InvitationSecurityEvent[] = [];
    const ring = keyRing();
    const input = issueInput(ring);
    input.email = secretMarker;
    const client = new FakeClient({ selectResult: issueRow() });
    const error = await capturedError(
      repository({ client, ring, events }).issueInvitation(input),
    );

    expect(error).toBeInstanceOf(OperationDeniedError);
    expect(Reflect.ownKeys(error).sort()).toEqual([
      "code",
      "message",
      "name",
      "stack",
    ]);
    expect(render(error)).not.toContain(secretMarker);
    expect(events).toHaveLength(1);
    expect(Object.keys(events[0]!).sort()).toEqual(["reason", "requestId"]);
    expect(Object.isFrozen(events[0])).toBe(true);
    expect(render(events)).not.toContain(secretMarker);
  });
});
