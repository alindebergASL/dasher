import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  AgentRunOperatorRepository,
  AgentRunRepository,
} from "./agent-run-repository.js";
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
  AGENT_RUN_VECTOR_FIELDS,
  type AttemptResourceVector,
  type CalculationMeterVector,
} from "./agent-run-types.js";

const ids = {
  dashboard: "50000000-0000-4000-8000-000000000001",
  snapshot: "50000000-0000-4000-8000-000000000002",
  runRequest: "50000000-0000-4000-8000-000000000003",
  run: "50000000-0000-4000-8000-000000000004",
  organization: "50000000-0000-4000-8000-000000000005",
  session: "50000000-0000-4000-8000-000000000006",
  user: "50000000-0000-4000-8000-000000000007",
  membership: "50000000-0000-4000-8000-000000000008",
  claimRequest: "50000000-0000-4000-8000-000000000009",
  attempt: "50000000-0000-4000-8000-00000000000a",
  candidate: "50000000-0000-4000-8000-00000000000b",
  brief: "50000000-0000-4000-8000-00000000000c",
  bundle: "50000000-0000-4000-8000-00000000000d",
  graph: "50000000-0000-4000-8000-00000000000e",
  result: "50000000-0000-4000-8000-00000000000f",
  terminalOperation: "50000000-0000-4000-8000-000000000010",
  cancelOperation: "50000000-0000-4000-8000-000000000011",
  sourceRun: "50000000-0000-4000-8000-000000000012",
  catalog: "50000000-0000-4000-8000-000000000013",
  contractSet: "50000000-0000-4000-8000-000000000014",
  replayResult: "50000000-0000-4000-8000-000000000015",
} as const;

const deploymentRevision = "task-9d-test";
const runLoginRole = "dasher_run_login_worker_a";
const databaseNow = new Date("2026-08-04T00:00:00.000Z");
const idleExpiresAt = new Date("2026-08-04T00:30:00.000Z");
const absoluteExpiresAt = new Date("2026-08-11T00:00:00.000Z");

function digest(seed: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(seed).digest());
}

function normalizedSqlSha256(sql: string): string {
  return createHash("sha256")
    .update(sql.replace(/\s+/gu, " ").trim())
    .digest("hex");
}

function keyRing(): SecretKeyRing {
  return new SecretKeyRing(
    {
      currentVersion: 1,
      verificationKeys: [{ version: 1, key: digest("key") }],
    },
    { randomBytes: () => digest("issued") },
  );
}

function issued(kind: "session" | "csrf"): string {
  return keyRing().issue(kind).wireValue;
}

function generatedUuid(index: number): string {
  return `60000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function uuidSource(): () => string {
  let index = 0;
  return () => {
    index += 1;
    return generatedUuid(index);
  };
}

function zeroVectorRow(prefix: string): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const field of AGENT_RUN_VECTOR_FIELDS) row[`${prefix}_${field}`] = "0";
  return row;
}

function vectorRow(prefix: string, base = 1): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  AGENT_RUN_VECTOR_FIELDS.forEach((field, offset) => {
    row[`${prefix}_${field}`] = String(base + offset);
  });
  return row;
}

function vectorInput(base = 1): AttemptResourceVector {
  const built: Record<string, bigint> = {};
  AGENT_RUN_VECTOR_FIELDS.forEach((field, offset) => {
    built[field] = BigInt(base + offset);
  });
  return built as unknown as AttemptResourceVector;
}

const meterInput: CalculationMeterVector = {
  inputBytes: 1n,
  astBytes: 2n,
  nodeCount: 3n,
  maxDepth: 4n,
  maxLiteralBytes: 5n,
  totalLiteralBytes: 6n,
  maxLiteralListLength: 7n,
  scannedRows: 8n,
  groupCount: 9n,
  maxGroupRows: 10n,
  cumulativeIntermediateRows: 11n,
  finalOutputRows: 12n,
  cumulativeIntermediateBytes: 13n,
  outputBytes: 14n,
  primitiveSteps: 15n,
  logicalAllocationBytes: 16n,
  maxTopK: 17n,
  maxWindowFrame: 18n,
  maxCoefficientDigits: 19n,
  maxScale: 20n,
};

function meterRow(): Record<string, unknown> {
  return {
    meter_input_bytes: "1",
    meter_ast_bytes: "2",
    meter_node_count: "3",
    meter_max_depth: "4",
    meter_max_literal_bytes: "5",
    meter_total_literal_bytes: "6",
    meter_max_literal_list_length: "7",
    meter_scanned_rows: "8",
    meter_group_count: "9",
    meter_max_group_rows: "10",
    meter_cumulative_intermediate_rows: "11",
    meter_final_output_rows: "12",
    meter_cumulative_intermediate_bytes: "13",
    meter_output_bytes: "14",
    meter_primitive_steps: "15",
    meter_logical_allocation_bytes: "16",
    meter_max_top_k: "17",
    meter_max_window_frame: "18",
    meter_max_coefficient_digits: "19",
    meter_max_scale: "20",
  };
}

function mutationRow(): Record<string, unknown> {
  return {
    run_id: ids.run,
    run_revision: "4",
    state: "planning",
    event_sequence: "4",
    event_sha256: digest("event"),
    lease_epoch: "1",
  };
}

function contextResult(): PgCompatibleQueryResult {
  return {
    rowCount: 1,
    rows: [
      {
        session_id: ids.session,
        user_id: ids.user,
        organization_id: ids.organization,
        membership_id: ids.membership,
        authority_revision: "3",
        idle_expires_at: new Date(idleExpiresAt),
        absolute_expires_at: new Date(absoluteExpiresAt),
        database_now: new Date(databaseNow),
      },
    ],
  };
}

interface QueryCall {
  readonly text: string;
  readonly values: readonly unknown[];
}

interface FakeClientOptions {
  readonly operation?: (
    text: string,
    values: readonly unknown[],
  ) => PgCompatibleQueryResult | Promise<PgCompatibleQueryResult>;
  readonly failure?: { readonly stage: string; readonly error: unknown };
  readonly releaseFailure?: boolean;
}

class FakeClient implements PgCompatibleClient {
  readonly calls: QueryCall[] = [];
  readonly releases: Array<boolean | undefined> = [];
  readonly #options: FakeClientOptions;

  constructor(options: FakeClientOptions) {
    this.#options = options;
  }

  async query(
    text: string,
    values?: unknown[],
  ): Promise<PgCompatibleQueryResult> {
    this.calls.push({ text, values: values ?? [] });
    const stage =
      text === "BEGIN"
        ? "begin"
        : text === "SET LOCAL ROLE dasher_run_operator"
          ? "set_role"
          : text === "SET LOCAL search_path = pg_catalog"
            ? "set_local"
            : text === "ROLLBACK"
              ? "rollback"
              : text === "COMMIT"
                ? "commit"
                : text.includes("initialize_context")
                  ? "initialize"
                  : "operation";
    if (this.#options.failure?.stage === stage) {
      throw this.#options.failure.error;
    }
    if (stage === "initialize") return contextResult();
    if (stage === "operation") {
      return await (this.#options.operation?.(text, values ?? []) ?? {
        rowCount: 0,
        rows: [],
      });
    }
    return { rowCount: null, rows: [] };
  }

  release(destroy?: boolean): void {
    this.releases.push(destroy);
    if (this.#options.releaseFailure && destroy !== true) {
      throw new Error("release failed");
    }
  }
}

interface Harness {
  readonly pool: PgCompatiblePool;
  readonly clients: FakeClient[];
  readonly connects: number[];
}

function harness(options: FakeClientOptions = {}): Harness {
  const clients: FakeClient[] = [];
  const connects: number[] = [];
  const pool: PgCompatiblePool = {
    connect: async () => {
      connects.push(clients.length);
      const client = new FakeClient(options);
      clients.push(client);
      return client;
    },
  };
  return { pool, clients, connects };
}

function failingPool(error: unknown): PgCompatiblePool {
  return {
    connect: async () => {
      throw error;
    },
  };
}

function databaseError(code: string): Error & { code: string } {
  const error = new Error("dasher") as Error & { code: string };
  error.code = code;
  return error;
}

function tenantRepository(pool: PgCompatiblePool): AgentRunRepository {
  return new AgentRunRepository({
    pool,
    keyRing: keyRing(),
    deploymentRevision,
    uuidSource: uuidSource(),
  });
}

function operatorRepository(
  pool: PgCompatiblePool,
): AgentRunOperatorRepository {
  return new AgentRunOperatorRepository({ pool, runLoginRole });
}

function requestInput(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    sessionToken: issued("session"),
    currentCsrfValue: issued("csrf"),
    dashboardId: ids.dashboard,
    inputSnapshotId: ids.snapshot,
    runRequestId: ids.runRequest,
    purpose: "suggest",
    expectedLifecycleRevision: 3,
    expectedInputSha256: digest("input"),
    idempotencySha256: digest("idempotency"),
    replaySourceRunId: null,
    ...overrides,
  };
}

function cancelInput(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    sessionToken: issued("session"),
    currentCsrfValue: issued("csrf"),
    runId: ids.run,
    expectedRunRevision: 4,
    cancelOperationAndAuditId: ids.cancelOperation,
    ...overrides,
  };
}

function fence(): Record<string, unknown> {
  return {
    runId: ids.run,
    leaseEpoch: 1,
    attemptToken: digest("token"),
  };
}

async function denied(action: () => Promise<unknown>): Promise<void> {
  await expect(action()).rejects.toBeInstanceOf(OperationDeniedError);
}

/* ------------------------------------------------------------------ */

describe("agent run repository: strict public surface", () => {
  it("exposes only the closed tenant method set", () => {
    expect(
      Object.getOwnPropertyNames(AgentRunRepository.prototype).sort(),
    ).toEqual([
      "cancelAgentRun",
      "constructor",
      "getAgentCandidate",
      "getAgentRun",
      "getAgentRunCheckpoint",
      "listAgentRunEvents",
      "requestAgentRun",
    ]);
  });

  it("exposes only the closed run-operator method set", () => {
    expect(
      Object.getOwnPropertyNames(AgentRunOperatorRepository.prototype).sort(),
    ).toEqual([
      "authorizeAttemptInvocation",
      "claimAgentRun",
      "cloneClaimedReplayPrerequisites",
      "closeCandidateSet",
      "commitBrief",
      "commitCalculationGraph",
      "commitCandidate",
      "commitCandidateClaims",
      "commitCandidateManifest",
      "commitCommonEvidenceBundle",
      "commitRunAbstention",
      "commitValidationFindings",
      "constructor",
      "consumeReplayResult",
      "finalizeRanking",
      "finishRun",
      "getClaimedRunInput",
      "listClaimedReplayResults",
      "reconcileAttempt",
      "releaseAttempt",
      "reserveAttempt",
      "startAttempt",
      "writeCheckpoint",
    ]);
  });

  it("exposes no SQL, budget, credential, tool, head, publication or schedule method", () => {
    const forbidden = [
      "query",
      "sql",
      "raw",
      "execute",
      "withClient",
      "setBudget",
      "overrideBudget",
      "credentials",
      "providerCredential",
      "callTool",
      "listTools",
      "selectTenant",
      "setOrganization",
      "updateHead",
      "compareAndSwapHead",
      "publish",
      "schedule",
      "acceptCandidate",
      "createDashboardVersion",
    ];
    for (const prototype of [
      AgentRunRepository.prototype,
      AgentRunOperatorRepository.prototype,
    ]) {
      for (const name of forbidden) {
        expect(Object.getOwnPropertyNames(prototype)).not.toContain(name);
        expect(
          (prototype as unknown as Record<string, unknown>)[name],
        ).toBeUndefined();
      }
    }
  });

  it("freezes constructed repositories", () => {
    expect(Object.isFrozen(tenantRepository(harness().pool))).toBe(true);
    expect(Object.isFrozen(operatorRepository(harness().pool))).toBe(true);
  });
});

describe("agent run repository: pre-connection hostile input", () => {
  it("rejects a hostile configuration without connecting", () => {
    const { pool, connects } = harness();
    const bad: readonly unknown[] = [
      null,
      undefined,
      "config",
      { pool: null, keyRing: keyRing(), deploymentRevision },
      { pool, keyRing: null, deploymentRevision },
      { pool, keyRing: keyRing(), deploymentRevision: "" },
      { pool, keyRing: keyRing(), deploymentRevision: " padded " },
      { pool, keyRing: keyRing(), deploymentRevision: "x".repeat(65) },
      { pool, keyRing: keyRing(), deploymentRevision, uuidSource: "no" },
      { pool, keyRing: keyRing(), deploymentRevision, smuggled: true },
      Object.assign(Object.create({ inherited: true }), {
        pool,
        keyRing: keyRing(),
        deploymentRevision,
      }),
      Object.defineProperty(
        { keyRing: keyRing(), deploymentRevision },
        "pool",
        { get: () => pool, enumerable: true },
      ),
      Object.assign(
        { pool, keyRing: keyRing(), deploymentRevision },
        {
          [Symbol("smuggled")]: true,
        },
      ),
      new Proxy({ pool, keyRing: keyRing(), deploymentRevision }, {}),
    ];
    for (const candidate of bad) {
      expect(() => new AgentRunRepository(candidate as never)).toThrow(
        OperationInternalError,
      );
    }
    expect(connects).toHaveLength(0);
  });

  it("rejects an unusable run-login identity without connecting", () => {
    const { pool, connects } = harness();
    const bad: readonly unknown[] = [
      null,
      { pool, runLoginRole: "" },
      { pool, runLoginRole: "Dasher_Run_Login" },
      { pool, runLoginRole: "dasher run login" },
      { pool, runLoginRole: "dasher_run_login_a; DROP" },
      { pool, runLoginRole: "postgres" },
      { pool, runLoginRole: "dasher_app" },
      { pool, runLoginRole: "dasher_run_operator" },
      { pool, runLoginRole: "dasher_run_definer" },
      { pool, runLoginRole: "dasher_security_definer" },
      { pool, runLoginRole: "dasher_retention_definer" },
      { pool, runLoginRole: "dasher_retention_operator" },
      { pool, runLoginRole: "a".repeat(64) },
      { pool: null, runLoginRole },
      { pool, runLoginRole, smuggled: true },
      Object.assign(Object.create({ inherited: true }), {
        pool,
        runLoginRole,
      }),
      Object.defineProperty({ pool }, "runLoginRole", {
        get: () => runLoginRole,
        enumerable: true,
      }),
      Object.assign({ pool, runLoginRole }, { [Symbol("smuggled")]: true }),
      new Proxy({ pool, runLoginRole }, {}),
    ];
    for (const candidate of bad) {
      expect(() => new AgentRunOperatorRepository(candidate as never)).toThrow(
        OperationInternalError,
      );
    }
    expect(connects).toHaveLength(0);
  });

  it("denies every hostile tenant request shape before connecting", async () => {
    const { pool, connects } = harness();
    const repository = tenantRepository(pool);
    const hostile: readonly Record<string, unknown>[] = [
      requestInput({ dashboardId: "not-a-uuid" }),
      requestInput({ inputSnapshotId: 7 }),
      requestInput({ purpose: "exfiltrate" }),
      requestInput({ purpose: "replay", replaySourceRunId: null }),
      requestInput({ replaySourceRunId: ids.sourceRun }),
      requestInput({ expectedLifecycleRevision: 0 }),
      requestInput({ expectedLifecycleRevision: 1.5 }),
      requestInput({ expectedInputSha256: digest("x").slice(0, 31) }),
      requestInput({ idempotencySha256: "deadbeef" }),
      requestInput({ sessionToken: "forged" }),
      requestInput({ currentCsrfValue: "forged" }),
    ];
    for (const input of hostile) {
      await denied(() => repository.requestAgentRun(input as never));
    }
    for (const extra of [{ smuggled: "value" }, { pool }]) {
      await denied(() =>
        repository.requestAgentRun({ ...requestInput(), ...extra } as never),
      );
    }
    expect(connects).toHaveLength(0);
  });

  it("denies every hostile lease fence before connecting", async () => {
    const { pool, connects } = harness();
    const repository = operatorRepository(pool);
    const hostile: readonly Record<string, unknown>[] = [
      { ...fence(), runId: "not-a-uuid" },
      { ...fence(), leaseEpoch: 0 },
      { ...fence(), leaseEpoch: -1 },
      { ...fence(), leaseEpoch: 2.5 },
      { ...fence(), attemptToken: digest("t").slice(0, 16) },
      { ...fence(), attemptToken: "hex" },
      { ...fence(), smuggled: 1 },
    ];
    for (const input of hostile) {
      await denied(() => repository.getClaimedRunInput(input as never));
    }
    await denied(() =>
      repository.claimAgentRun({
        claimRequestId: "not-a-uuid",
        leaseSeconds: 30,
      } as never),
    );
    for (const seconds of [0, -1, 3.5, 901, 3_601, "30"]) {
      await denied(() =>
        repository.claimAgentRun({
          claimRequestId: ids.claimRequest,
          leaseSeconds: seconds,
        } as never),
      );
    }
    await denied(() =>
      repository.listClaimedReplayResults({
        ...fence(),
        afterSourceSequence: 0,
        limit: 6,
      } as never),
    );
    await denied(() =>
      repository.consumeReplayResult({
        ...fence(),
        sourceResultSequence: 6,
        sourceResultSha256: digest("source"),
      } as never),
    );
    expect(connects).toHaveLength(0);
  });

  it("forwards present zero-length accounting bytes to fixed reconcile SQL", async () => {
    const { pool, clients, connects } = harness({
      operation: () => {
        throw databaseError("P1001");
      },
    });
    const repository = operatorRepository(pool);
    const accounting = new Uint8Array(0);

    await expect(
      repository.reconcileAttempt({
        ...fence(),
        attemptId: ids.attempt,
        outcome: "succeeded",
        actualAccountingBytes: accounting,
        resultSha256: digest("r"),
        canonicalRecordedResultBytes: new Uint8Array(1),
      } as never),
    ).rejects.toBeInstanceOf(OperationDeniedError);

    expect(connects).toHaveLength(1);
    const operation = clients[0]!.calls[3]!;
    expect(operation.text).toContain(
      "dasher_run_api.reconcile_agent_run_attempt(",
    );
    expect(operation.values[5]).toEqual(new Uint8Array(0));
    expect(operation.values[5]).not.toBe(accounting);
  });

  it("denies hostile reconcile shapes before connecting", async () => {
    const { pool, connects } = harness();
    const repository = operatorRepository(pool);
    const hostile: readonly Record<string, unknown>[] = [
      { ...fence(), attemptId: ids.attempt, outcome: "maybe" },
      {
        ...fence(),
        attemptId: ids.attempt,
        outcome: "indeterminate",
        actualAccountingBytes: new Uint8Array(1),
      },
      { ...fence(), attemptId: ids.attempt, outcome: "succeeded" },
      {
        ...fence(),
        attemptId: ids.attempt,
        outcome: "succeeded",
        actualAccountingBytes: new Uint8Array(1_025),
        resultSha256: digest("r"),
        canonicalRecordedResultBytes: new Uint8Array(1),
      },
    ];
    for (const input of hostile) {
      await denied(() => repository.reconcileAttempt(input as never));
    }
    expect(connects).toHaveLength(0);
  });
});

describe("agent run repository: tenant transaction wrapper", () => {
  function requestRow(): PgCompatibleQueryResult {
    return {
      rowCount: 1,
      rows: [
        {
          run_id: ids.run,
          run_revision: "1",
          state: "requested",
          policy_revision: "1",
          request_sha256: digest("request"),
        },
      ],
    };
  }

  it("pins one fixed request statement inside the context transaction", async () => {
    const { pool, clients } = harness({ operation: () => requestRow() });
    const result = await tenantRepository(pool).requestAgentRun(
      requestInput() as never,
    );
    const client = clients[0]!;
    expect(client.calls.map((call) => call.text.split("\n")[0])).toEqual([
      "BEGIN",
      "SET LOCAL search_path = pg_catalog",
      client.calls[2]!.text.split("\n")[0],
      client.calls[3]!.text.split("\n")[0],
      "COMMIT",
    ]);
    expect(client.calls[2]!.text).toContain("dasher_api.initialize_context(");
    const operation = client.calls[3]!;
    expect(operation.text).toContain("dasher_api.request_agent_run(");
    expect(operation.text).not.toContain(";");
    expect(operation.text.match(/\$\d+::/g)).toHaveLength(12);
    expect(operation.values).toHaveLength(12);
    expect(operation.values[3]).toBe("suggest");
    expect(operation.values[10]).toBe(deploymentRevision);
    // A fresh audit identifier, never the caller's run request id.
    expect(operation.values[7]).toBe(generatedUuid(2));
    expect(operation.values[7]).not.toBe(ids.runRequest);
    expect(result.runId).toBe(ids.run);
    expect(result.state).toBe("requested");
    expect(client.releases).toEqual([undefined]);
  });

  it("passes the exact verified csrf key version and digest", async () => {
    const { pool, clients } = harness({ operation: () => requestRow() });
    await tenantRepository(pool).requestAgentRun(requestInput() as never);
    const operation = clients[0]!.calls[3]!;
    const material = keyRing().verify("csrf", issued("csrf"));
    expect(operation.values[8]).toBe(material.keyVersion);
    expect(operation.values[9]).toEqual(material.digest);
  });

  it("sends the frozen cancel reason and retains the caller operation uuid", async () => {
    const cancelRow = {
      rowCount: 1,
      rows: [
        {
          run_id: ids.run,
          run_revision: "5",
          state: "cancelled",
          event_sequence: "5",
          event_sha256: digest("cancel-event"),
        },
      ],
    } satisfies PgCompatibleQueryResult;
    const first = harness({ operation: () => cancelRow });
    const second = harness({ operation: () => cancelRow });
    const input = cancelInput();
    const a = await tenantRepository(first.pool).cancelAgentRun(input as never);
    const b = await tenantRepository(second.pool).cancelAgentRun(
      input as never,
    );
    const left = first.clients[0]!.calls[3]!;
    const right = second.clients[0]!.calls[3]!;
    expect(left.text).toBe(right.text);
    expect(left.values).toEqual(right.values);
    expect(left.values[2]).toEqual(right.values[2]);
    expect(left.values[2]).not.toBe(right.values[2]);
    expect(new TextDecoder().decode(left.values[2] as Uint8Array)).toBe(
      '{"reason":"user_requested","schema":"run-cancel-reason-v1"}',
    );
    expect(left.values[3]).toBe(ids.cancelOperation);
    expect(a).toEqual(b);
    expect(a.state).toBe("cancelled");
  });

  it("maps P1001 to denial and P1002 to conflict", async () => {
    const deniedHarness = harness({
      operation: () => {
        throw databaseError("P1001");
      },
    });
    await expect(
      tenantRepository(deniedHarness.pool).requestAgentRun(
        requestInput() as never,
      ),
    ).rejects.toBeInstanceOf(OperationDeniedError);
    expect(deniedHarness.clients[0]!.calls.at(-1)!.text).toBe("ROLLBACK");

    const conflictHarness = harness({
      operation: () => {
        throw databaseError("P1002");
      },
    });
    await expect(
      tenantRepository(conflictHarness.pool).requestAgentRun(
        requestInput() as never,
      ),
    ).rejects.toBeInstanceOf(OperationConflictError);
  });

  it("reports commit_indeterminate and destroys the client on commit failure", async () => {
    const { pool, clients } = harness({
      operation: () => requestRow(),
      failure: { stage: "commit", error: new Error("commit") },
    });
    await expect(
      tenantRepository(pool).requestAgentRun(requestInput() as never),
    ).rejects.toMatchObject({ outcome: "commit_indeterminate" });
    expect(clients[0]!.releases).toEqual([true]);
  });

  it("validates read projections and rejects a foreign run row", async () => {
    const { pool } = harness({
      operation: () => ({
        rowCount: 1,
        rows: [
          {
            run_id: ids.sourceRun,
            dashboard_id: ids.dashboard,
            state: "planning",
            run_revision: "2",
            policy_revision: "1",
            requested_at: new Date(databaseNow),
            terminal_at: null,
            latest_event_sequence: "2",
            latest_checkpoint_revision: null,
            selected_candidate_id: null,
          },
        ],
      }),
    });
    await expect(
      tenantRepository(pool).getAgentRun({
        sessionToken: issued("session"),
        runId: ids.run,
      } as never),
    ).rejects.toBeInstanceOf(OperationInternalError);
  });

  it("bounds the event listing window", async () => {
    const { pool, connects } = harness();
    const repository = tenantRepository(pool);
    for (const limit of [0, 101, 1.5, "10"]) {
      await denied(() =>
        repository.listAgentRunEvents({
          sessionToken: issued("session"),
          runId: ids.run,
          afterSequence: 0,
          limit,
        } as never),
      );
    }
    expect(connects).toHaveLength(0);
  });
});

describe("agent run repository: run-operator transaction wrapper", () => {
  function claimRow(overrides: Record<string, unknown> = {}): {
    rowCount: number;
    rows: Record<string, unknown>[];
  } {
    return {
      rowCount: 1,
      rows: [
        {
          status: "claimed",
          organization_id: ids.organization,
          dashboard_id: ids.dashboard,
          run_id: ids.run,
          run_revision: "2",
          state: "authorized",
          lease_epoch: "1",
          attempt_token: digest("token"),
          lease_expires_at: new Date("2026-08-04T00:01:00.000Z"),
          policy_revision: "1",
          input_sha256: digest("input"),
          ...overrides,
        },
      ],
    };
  }

  it("runs begin, role, search path, one fixed call and commit", async () => {
    const { pool, clients } = harness({ operation: () => claimRow() });
    await operatorRepository(pool).claimAgentRun({
      claimRequestId: ids.claimRequest,
      leaseSeconds: 30,
    } as never);
    const client = clients[0]!;
    expect(client.calls[0]!.text).toBe("BEGIN");
    expect(client.calls[1]!.text).toBe("SET LOCAL ROLE dasher_run_operator");
    expect(client.calls[2]!.text).toBe("SET LOCAL search_path = pg_catalog");
    expect(client.calls[3]!.text).toContain("dasher_run_api.claim_agent_run(");
    expect(client.calls[4]!.text).toBe("COMMIT");
    expect(client.calls).toHaveLength(5);
    // No tenant context is established on the operator path.
    expect(
      client.calls.some((call) => call.text.includes("initialize_context")),
    ).toBe(false);
    expect(client.releases).toEqual([undefined]);
  });

  it("passes only the claim request id and lease seconds", async () => {
    const { pool, clients } = harness({ operation: () => claimRow() });
    await operatorRepository(pool).claimAgentRun({
      claimRequestId: ids.claimRequest,
      leaseSeconds: 45,
    } as never);
    const operation = clients[0]!.calls[3]!;
    // The caller supplies no organization, dashboard, run, tenant, policy or
    // capability selector: only the idempotency identifier and lease bound.
    expect(operation.values).toEqual([ids.claimRequest, 45]);
    expect(operation.values).toHaveLength(2);
  });

  it("returns the three exact discriminated claim results", async () => {
    const claimed = harness({ operation: () => claimRow() });
    const first = await operatorRepository(claimed.pool).claimAgentRun({
      claimRequestId: ids.claimRequest,
      leaseSeconds: 30,
    } as never);
    expect(first.status).toBe("claimed");
    if (first.status !== "claimed") throw new Error("unreachable");
    expect(first.lease.runId).toBe(ids.run);
    expect(first.lease.leaseEpoch).toBe(1);
    expect(first.lease.attemptToken).toEqual(digest("token"));

    const terminal = harness({
      operation: () =>
        claimRow({
          status: "terminalized_indeterminate",
          state: "failed",
          attempt_token: null,
          lease_expires_at: null,
          input_sha256: null,
        }),
    });
    const second = await operatorRepository(terminal.pool).claimAgentRun({
      claimRequestId: ids.claimRequest,
      leaseSeconds: 30,
    } as never);
    expect(second.status).toBe("terminalized_indeterminate");
    if (second.status !== "terminalized_indeterminate") {
      throw new Error("unreachable");
    }
    expect(second.terminal.runId).toBe(ids.run);
    expect(second.terminal).not.toHaveProperty("attemptToken");
    expect(second.terminal).not.toHaveProperty("leaseExpiresAt");

    const empty = harness({
      operation: () => ({
        rowCount: 1,
        rows: [
          {
            status: "no_eligible_run",
            organization_id: null,
            dashboard_id: null,
            run_id: null,
            run_revision: null,
            state: null,
            lease_epoch: null,
            attempt_token: null,
            lease_expires_at: null,
            policy_revision: null,
            input_sha256: null,
          },
        ],
      }),
    });
    const third = await operatorRepository(empty.pool).claimAgentRun({
      claimRequestId: ids.claimRequest,
      leaseSeconds: 30,
    } as never);
    expect(third).toEqual({ status: "no_eligible_run" });
  });

  it("rolls a lost race back before mapping it to no claim", async () => {
    const { pool, clients } = harness({
      operation: () => {
        throw databaseError("P1002");
      },
    });
    const result = await operatorRepository(pool).claimAgentRun({
      claimRequestId: ids.claimRequest,
      leaseSeconds: 30,
    } as never);
    expect(result).toEqual({ status: "no_eligible_run" });
    const client = clients[0]!;
    expect(client.calls.at(-1)!.text).toBe("ROLLBACK");
    expect(client.releases).toEqual([undefined]);
  });

  it("never maps a fixed P1001 to no claim", async () => {
    const { pool } = harness({
      operation: () => {
        throw databaseError("P1001");
      },
    });
    await expect(
      operatorRepository(pool).claimAgentRun({
        claimRequestId: ids.claimRequest,
        leaseSeconds: 30,
      } as never),
    ).rejects.toBeInstanceOf(OperationDeniedError);
  });

  it("destroys the client when the lost-race rollback itself fails", async () => {
    const { pool, clients } = harness({
      operation: () => {
        throw databaseError("P1002");
      },
      failure: { stage: "rollback", error: new Error("rollback") },
    });
    await expect(
      operatorRepository(pool).claimAgentRun({
        claimRequestId: ids.claimRequest,
        leaseSeconds: 30,
      } as never),
    ).rejects.toBeInstanceOf(OperationInternalError);
    expect(clients[0]!.releases).toEqual([true]);
  });

  it("destroys the client when a normal release fails", async () => {
    const { pool, clients } = harness({
      operation: () => claimRow(),
      releaseFailure: true,
    });
    await operatorRepository(pool).claimAgentRun({
      claimRequestId: ids.claimRequest,
      leaseSeconds: 30,
    } as never);
    expect(clients[0]!.releases).toEqual([undefined, true]);
  });

  it("uses a fresh transaction for a retry and reuses the pool", async () => {
    const { pool, clients, connects } = harness({
      operation: () => claimRow(),
    });
    const repository = operatorRepository(pool);
    await repository.claimAgentRun({
      claimRequestId: ids.claimRequest,
      leaseSeconds: 30,
    } as never);
    await repository.claimAgentRun({
      claimRequestId: ids.claimRequest,
      leaseSeconds: 30,
    } as never);
    expect(connects).toHaveLength(2);
    expect(clients).toHaveLength(2);
    for (const client of clients) {
      expect(client.calls[0]!.text).toBe("BEGIN");
      expect(client.calls.at(-1)!.text).toBe("COMMIT");
      expect(client.releases).toEqual([undefined]);
    }
  });

  it("normalizes an AggregateError from the pool without leaking it", async () => {
    const aggregate = new AggregateError(
      [databaseError("P1001"), new Error("second")],
      "all connections failed",
    );
    Object.defineProperty(aggregate, "code", { value: "P1002" });
    const repository = operatorRepository(failingPool(aggregate));
    const failure = await repository
      .claimAgentRun({
        claimRequestId: ids.claimRequest,
        leaseSeconds: 30,
      } as never)
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(OperationInternalError);
    expect(failure).not.toBeInstanceOf(AggregateError);
    expect((failure as OperationInternalError).outcome).toBe("not_committed");
    expect(String(failure)).not.toContain("all connections failed");
  });

  it("normalizes an AggregateError raised by the fixed call", async () => {
    const { pool } = harness({
      operation: () => {
        throw new AggregateError([new Error("a")], "b");
      },
    });
    await expect(
      operatorRepository(pool).claimAgentRun({
        claimRequestId: ids.claimRequest,
        leaseSeconds: 30,
      } as never),
    ).rejects.toBeInstanceOf(OperationInternalError);
  });
});

describe("agent run repository: post-claim fixed calls", () => {
  async function callOne(
    invoke: (repository: AgentRunOperatorRepository) => Promise<unknown>,
    operation: (
      text: string,
      values: readonly unknown[],
    ) => PgCompatibleQueryResult,
  ): Promise<QueryCall> {
    const { pool, clients } = harness({ operation });
    await invoke(operatorRepository(pool));
    const client = clients[0]!;
    expect(client.calls).toHaveLength(5);
    return client.calls[3]!;
  }

  it("verifies the exact returned run handle on every post-claim call", async () => {
    const { pool } = harness({
      operation: () => ({
        rowCount: 1,
        rows: [{ ...mutationRow(), run_id: ids.sourceRun }],
      }),
    });
    await expect(
      operatorRepository(pool).commitBrief({
        ...fence(),
        briefId: ids.brief,
        canonicalBriefBytes: new TextEncoder().encode("{}"),
      } as never),
    ).rejects.toBeInstanceOf(OperationInternalError);
  });

  it("rejects a mutation whose lease epoch is behind the fence", async () => {
    const { pool } = harness({
      operation: () => ({
        rowCount: 1,
        rows: [
          {
            ...mutationRow(),
            lease_epoch: "0",
            object_id: ids.brief,
            content_sha256: digest("brief"),
          },
        ],
      }),
    });
    await expect(
      operatorRepository(pool).commitBrief({
        ...fence(),
        briefId: ids.brief,
        canonicalBriefBytes: new TextEncoder().encode("{}"),
      } as never),
    ).rejects.toBeInstanceOf(OperationInternalError);
  });

  it("rejects a mutation whose lease epoch is ahead of the exact fence", async () => {
    const { pool } = harness({
      operation: () => ({
        rowCount: 1,
        rows: [
          {
            ...mutationRow(),
            lease_epoch: "2",
            object_id: ids.brief,
            content_sha256: digest("brief"),
          },
        ],
      }),
    });
    await expect(
      operatorRepository(pool).commitBrief({
        ...fence(),
        briefId: ids.brief,
        canonicalBriefBytes: new TextEncoder().encode("{}"),
      } as never),
    ).rejects.toBeInstanceOf(OperationInternalError);
  });

  it("passes reconcile accounting bytes through untouched and unlogged", async () => {
    const opaque = new Uint8Array([0x7b, 0x00, 0xff, 0x20, 0x7d]);
    const call = await callOne(
      (repository) =>
        repository.reconcileAttempt({
          ...fence(),
          attemptId: ids.attempt,
          outcome: "succeeded",
          actualAccountingBytes: opaque,
          resultSha256: digest("result"),
          canonicalRecordedResultBytes: new TextEncoder().encode("{}"),
        } as never),
      () => ({
        rowCount: 1,
        rows: [
          {
            ...mutationRow(),
            attempt_id: ids.attempt,
            attempt_state: "succeeded",
            ...vectorRow("reserved"),
            ...vectorRow("used"),
            ...zeroVectorRow("released"),
            ...zeroVectorRow("outstanding"),
          },
        ],
      }),
    );
    expect(call.text).toContain("dasher_run_api.reconcile_agent_run_attempt(");
    expect(call.text).toContain("$6::bytea");
    expect(call.text).not.toContain("attempt_resource_vector");
    expect(call.values[5]).toEqual(opaque);
    expect(call.values[5]).not.toBe(opaque);
    expect(call.values[5]).toBeInstanceOf(Uint8Array);
  });

  it("captures resizable accounting bytes once across awaits and a rolled-back retry", async () => {
    let releaseFirst!: () => void;
    let markEntered!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const operationEntered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    let firstParameter: Uint8Array | null = null;
    const first = harness({
      operation: async (_text, values) => {
        firstParameter = values[5] as Uint8Array;
        markEntered();
        await firstGate;
        throw databaseError("P1001");
      },
    });
    const ResizableArrayBuffer = ArrayBuffer as unknown as new (
      byteLength: number,
      options: { maxByteLength: number },
    ) => ArrayBuffer & { resize(byteLength: number): void };
    const buffer = new ResizableArrayBuffer(8, { maxByteLength: 2_048 });
    const live = new Uint8Array(buffer);
    live.set([1, 2, 3, 4, 5, 6, 7, 8]);
    const input = {
      ...fence(),
      attemptId: ids.attempt,
      outcome: "succeeded",
      actualAccountingBytes: live,
      resultSha256: digest("result"),
      canonicalRecordedResultBytes: new TextEncoder().encode("{}"),
    } as const;
    const failed = operatorRepository(first.pool).reconcileAttempt(
      input as never,
    );
    await operationEntered;
    buffer.resize(1_024);
    live.fill(255);
    releaseFirst();
    await expect(failed).rejects.toBeInstanceOf(OperationDeniedError);
    expect(first.clients[0]!.calls.at(-1)!.text).toBe("ROLLBACK");
    expect(firstParameter).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    expect(firstParameter).not.toBe(live);

    const retry = harness({
      operation: (_text, values) => {
        expect(values[5]).toEqual(firstParameter);
        return {
          rowCount: 1,
          rows: [
            {
              ...mutationRow(),
              attempt_id: ids.attempt,
              attempt_state: "succeeded",
              ...vectorRow("reserved"),
              ...vectorRow("used"),
              ...zeroVectorRow("released"),
              ...zeroVectorRow("outstanding"),
            },
          ],
        };
      },
    });
    await operatorRepository(retry.pool).reconcileAttempt({
      ...input,
      actualAccountingBytes: firstParameter!,
    } as never);
    expect(retry.clients[0]!.calls.at(-1)!.text).toBe("COMMIT");
  });

  it("sends an indeterminate reconcile with three SQL nulls", async () => {
    const call = await callOne(
      (repository) =>
        repository.reconcileAttempt({
          ...fence(),
          attemptId: ids.attempt,
          outcome: "indeterminate",
        } as never),
      () => ({
        rowCount: 1,
        rows: [
          {
            ...mutationRow(),
            state: "failed",
            attempt_id: ids.attempt,
            attempt_state: "indeterminate_quarantined",
            ...vectorRow("reserved"),
            ...vectorRow("used"),
            ...zeroVectorRow("released"),
            ...zeroVectorRow("outstanding"),
          },
        ],
      }),
    );
    expect(call.values[4]).toBe("indeterminate");
    expect(call.values[5]).toBeNull();
    expect(call.values[6]).toBeNull();
    expect(call.values[7]).toBeNull();
  });

  it("builds the reservation vector from fourteen fixed bigint parameters", async () => {
    const call = await callOne(
      (repository) =>
        repository.reserveAttempt({
          ...fence(),
          attemptId: ids.attempt,
          partition: "generation",
          attemptKind: "planner",
          reservedVector: vectorInput(),
          canonicalRequestBytes: new TextEncoder().encode("{}"),
        } as never),
      () => ({
        rowCount: 1,
        rows: [
          {
            ...mutationRow(),
            attempt_id: ids.attempt,
            ...vectorRow("reserved"),
          },
        ],
      }),
    );
    expect(call.text).toContain("dasher_run_api.reserve_agent_run_attempt(");
    expect(call.text).toContain("::dasher_run_api.attempt_resource_vector");
    expect(call.values).toHaveLength(21);
    // Six scalar arguments, then the fourteen vector fields in frozen order,
    // then the canonical request bytes.
    expect(call.values.slice(6, 20)).toEqual(
      AGENT_RUN_VECTOR_FIELDS.map((_, index) => String(index + 1)),
    );
    expect(call.values[20]).toBeInstanceOf(Uint8Array);
  });

  it("sends the twenty calculation meter fields in frozen order", async () => {
    const call = await callOne(
      (repository) =>
        repository.commitCalculationGraph({
          ...fence(),
          graphId: ids.graph,
          canonicalGraphBytes: new TextEncoder().encode("{}"),
          canonicalResultBytes: new TextEncoder().encode("{}"),
          meterVector: meterInput,
          expectedInputSha256: digest("input"),
        } as never),
      () => ({
        rowCount: 1,
        rows: [
          {
            ...mutationRow(),
            graph_id: ids.graph,
            result_id: ids.result,
            graph_sha256: digest("graph"),
            result_sha256: digest("calc"),
            ...meterRow(),
          },
        ],
      }),
    );
    expect(call.text).toContain("dasher_run_api.commit_calculation_graph(");
    expect(call.values).toHaveLength(27);
    expect(call.values.slice(6, 26)).toEqual(
      Array.from({ length: 20 }, (_, index) => String(index + 1)),
    );
    expect(call.values[26]).toEqual(digest("input"));
  });

  it("reads bounded replay results through one fixed set-returning call", async () => {
    const { pool, clients } = harness({
      operation: () => ({
        rowCount: 2,
        rows: [
          {
            source_run_id: ids.sourceRun,
            source_result_sequence: "1",
            source_result_sha256: digest("r1"),
            result_kind: "planner_output",
            canonical_result_bytes: new TextEncoder().encode("{}"),
          },
          {
            source_run_id: ids.sourceRun,
            source_result_sequence: "2",
            source_result_sha256: digest("r2"),
            result_kind: "candidate_output",
            canonical_result_bytes: new TextEncoder().encode("{}"),
          },
        ],
      }),
    });
    const results = await operatorRepository(pool).listClaimedReplayResults({
      ...fence(),
      afterSourceSequence: 0,
      limit: 5,
    } as never);
    expect(results).toHaveLength(2);
    expect(results[0]!.sourceResultSequence).toBe(1);
    expect(results[1]!.resultKind).toBe("candidate_output");
    expect(clients[0]!.calls).toHaveLength(5);
    expect(clients[0]!.calls[3]!.text).toContain(
      "dasher_run_api.list_claimed_replay_results(",
    );
  });

  it("rejects replay rows that are out of order or foreign", async () => {
    const { pool } = harness({
      operation: () => ({
        rowCount: 2,
        rows: [
          {
            source_run_id: ids.sourceRun,
            source_result_sequence: "2",
            source_result_sha256: digest("r2"),
            result_kind: "planner_output",
            canonical_result_bytes: new TextEncoder().encode("{}"),
          },
          {
            source_run_id: ids.sourceRun,
            source_result_sequence: "1",
            source_result_sha256: digest("r1"),
            result_kind: "planner_output",
            canonical_result_bytes: new TextEncoder().encode("{}"),
          },
        ],
      }),
    });
    await expect(
      operatorRepository(pool).listClaimedReplayResults({
        ...fence(),
        afterSourceSequence: 0,
        limit: 5,
      } as never),
    ).rejects.toBeInstanceOf(OperationInternalError);
  });

  it("rejects a consumed replay result whose returned sha is not the requested sha", async () => {
    const { pool } = harness({
      operation: () => ({
        rowCount: 1,
        rows: [
          {
            ...mutationRow(),
            source_result_sequence: "1",
            source_result_sha256: digest("foreign-source"),
            replay_result_id: ids.replayResult,
          },
        ],
      }),
    });
    await expect(
      operatorRepository(pool).consumeReplayResult({
        ...fence(),
        sourceResultSequence: 1,
        sourceResultSha256: digest("source"),
      } as never),
    ).rejects.toBeInstanceOf(OperationInternalError);
  });

  it("uses a fixed call and no composite cast for every remaining function", async () => {
    const expected: readonly [string, string][] = [
      ["getClaimedRunInput", "dasher_run_api.get_claimed_agent_run_input("],
      [
        "cloneClaimedReplayPrerequisites",
        "dasher_run_api.clone_claimed_replay_prerequisites(",
      ],
      ["consumeReplayResult", "dasher_run_api.consume_agent_replay_result("],
      ["writeCheckpoint", "dasher_run_api.write_agent_run_checkpoint("],
      ["commitBrief", "dasher_run_api.commit_agent_brief("],
      [
        "commitCommonEvidenceBundle",
        "dasher_run_api.commit_common_evidence_bundle(",
      ],
      ["startAttempt", "dasher_run_api.start_agent_run_attempt("],
      [
        "authorizeAttemptInvocation",
        "dasher_run_api.authorize_agent_run_attempt_invocation(",
      ],
      ["releaseAttempt", "dasher_run_api.release_agent_run_attempt("],
      ["commitCandidate", "dasher_run_api.commit_agent_candidate("],
      [
        "commitValidationFindings",
        "dasher_run_api.commit_agent_validation_findings(",
      ],
      ["closeCandidateSet", "dasher_run_api.close_agent_candidate_set("],
      ["commitCandidateClaims", "dasher_run_api.commit_candidate_claims("],
      ["commitCandidateManifest", "dasher_run_api.commit_candidate_manifest("],
      ["commitRunAbstention", "dasher_run_api.commit_run_abstention("],
      ["finalizeRanking", "dasher_run_api.finalize_agent_run_ranking("],
      ["finishRun", "dasher_run_api.finish_agent_run("],
    ];
    for (const [method, fragment] of expected) {
      const { pool, clients } = harness({
        operation: () => {
          throw databaseError("P1001");
        },
      });
      const repository = operatorRepository(pool) as unknown as Record<
        string,
        (input: unknown) => Promise<unknown>
      >;
      await expect(
        repository[method]!(postClaimInput(method)),
      ).rejects.toBeInstanceOf(OperationDeniedError);
      const call = clients[0]!.calls[3]!;
      expect(call.text).toContain(fragment);
      expect(call.text).not.toContain(";");
      expect(call.text).not.toContain("EXECUTE");
      expect(call.text.split("dasher_run_api.")).toHaveLength(2);
    }
  });
});

function postClaimInput(method: string): Record<string, unknown> {
  const bytes = new TextEncoder().encode("{}");
  const base = fence();
  switch (method) {
    case "getClaimedRunInput":
    case "cloneClaimedReplayPrerequisites":
      return base;
    case "listClaimedReplayResults":
      return { ...base, afterSourceSequence: 0, limit: 5 };
    case "consumeReplayResult":
      return {
        ...base,
        sourceResultSequence: 1,
        sourceResultSha256: digest("source"),
      };
    case "writeCheckpoint":
      return {
        ...base,
        sourceEventSequence: 4,
        sourceEventSha256: digest("source-event"),
        canonicalCheckpointBytes: bytes,
      };
    case "commitBrief":
      return { ...base, briefId: ids.brief, canonicalBriefBytes: bytes };
    case "commitCommonEvidenceBundle":
      return { ...base, bundleId: ids.bundle, canonicalBundleBytes: bytes };
    case "startAttempt":
    case "authorizeAttemptInvocation":
      return {
        ...base,
        attemptId: ids.attempt,
        dispatchRequestSha256: digest("dispatch"),
      };
    case "reserveAttempt":
      return {
        ...base,
        attemptId: ids.attempt,
        partition: "generation",
        attemptKind: "planner",
        reservedVector: vectorInput(),
        canonicalRequestBytes: bytes,
      };
    case "reconcileAttempt":
      return {
        ...base,
        attemptId: ids.attempt,
        outcome: "succeeded",
        actualAccountingBytes: new Uint8Array([1]),
        resultSha256: digest("result"),
        canonicalRecordedResultBytes: bytes,
      };
    case "commitCalculationGraph":
      return {
        ...base,
        graphId: ids.graph,
        canonicalGraphBytes: bytes,
        canonicalResultBytes: bytes,
        meterVector: meterInput,
        expectedInputSha256: digest("input"),
      };
    case "releaseAttempt":
      return {
        ...base,
        attemptId: ids.attempt,
        reason: "adapter_setup_failed",
        releaseProofSha256: digest("release"),
      };
    case "commitCandidate":
      return {
        ...base,
        candidateId: ids.candidate,
        canonicalDashboardSpecBytes: bytes,
        commonBundleSha256: digest("bundle"),
        sourceResultId: ids.result,
        sourceResultSha256: digest("source-result"),
        precommitValidationSha256: digest("precommit"),
      };
    case "commitValidationFindings":
      return {
        ...base,
        candidateId: ids.candidate,
        canonicalFindingsBytes: bytes,
      };
    case "closeCandidateSet":
      return { ...base, orderedCandidateSetSha256: digest("set") };
    case "commitCandidateClaims":
      return {
        ...base,
        candidateId: ids.candidate,
        canonicalClaimEdgeSetBytes: bytes,
      };
    case "commitCandidateManifest":
      return {
        ...base,
        candidateId: ids.candidate,
        canonicalManifestBytes: bytes,
        reviewerResultSha256: digest("reviewer"),
      };
    case "commitRunAbstention":
      return {
        ...base,
        terminalOperationId: ids.terminalOperation,
        canonicalAbstentionBytes: bytes,
      };
    case "finalizeRanking":
      return {
        ...base,
        terminalOperationId: ids.terminalOperation,
        selectedCandidateId: ids.candidate,
        rankingProofSha256: digest("ranking"),
      };
    case "finishRun":
      return {
        ...base,
        terminalOperationId: ids.terminalOperation,
        terminalOutcome: "failed",
        canonicalReasonBytes: bytes,
      };
    default:
      throw new Error(`unmapped method ${method}`);
  }
}

describe("agent run repository: claimed input projection", () => {
  it("projects the exact limit vectors and replay bindings", async () => {
    const { pool } = harness({
      operation: () => ({
        rowCount: 1,
        rows: [
          {
            run_id: ids.run,
            purpose: "replay",
            evaluation_time: new Date(databaseNow),
            policy_revision: "1",
            input_snapshot_id: ids.snapshot,
            input_sha256: digest("input"),
            input_row_count: "12",
            field_catalog_snapshot_id: ids.catalog,
            metric_contract_set_id: ids.contractSet,
            metric_contract_set_sha256: digest("contract"),
            ...vectorRow("generation_limit"),
            ...vectorRow("review_limit", 100),
            replay_source_run_id: ids.sourceRun,
            replay_source_result_count: 3,
            replay_source_head_sequence: "9",
            replay_source_head_sha256: digest("head"),
            replay_source_candidate_set_sha256: digest("set"),
            replay_source_bundle_id: ids.bundle,
            replay_source_bundle_sha256: digest("bundle"),
            replay_source_brief_id: ids.brief,
            replay_source_brief_sha256: digest("brief"),
            replay_source_selected_candidate_id: ids.candidate,
            canonical_input_bytes: new TextEncoder().encode("{}"),
            canonical_request_bytes: new TextEncoder().encode("{}"),
          },
        ],
      }),
    });
    const projection = await operatorRepository(pool).getClaimedRunInput(
      fence() as never,
    );
    expect(projection.purpose).toBe("replay");
    expect(projection.generationLimitVector.calls).toBe(1n);
    expect(projection.reviewLimitVector.calls).toBe(100n);
    expect(projection.replaySourceResultCount).toBe(3);
    expect(projection.replaySourceRunId).toBe(ids.sourceRun);
    expect(Object.isFrozen(projection)).toBe(true);
  });

  it("rejects a suggest projection that carries replay bindings", async () => {
    const { pool } = harness({
      operation: () => ({
        rowCount: 1,
        rows: [
          {
            run_id: ids.run,
            purpose: "suggest",
            evaluation_time: new Date(databaseNow),
            policy_revision: "1",
            input_snapshot_id: ids.snapshot,
            input_sha256: digest("input"),
            input_row_count: "12",
            field_catalog_snapshot_id: ids.catalog,
            metric_contract_set_id: ids.contractSet,
            metric_contract_set_sha256: digest("contract"),
            ...vectorRow("generation_limit"),
            ...vectorRow("review_limit", 100),
            replay_source_run_id: ids.sourceRun,
            replay_source_result_count: 3,
            replay_source_head_sequence: "9",
            replay_source_head_sha256: digest("head"),
            replay_source_candidate_set_sha256: digest("set"),
            replay_source_bundle_id: ids.bundle,
            replay_source_bundle_sha256: digest("bundle"),
            replay_source_brief_id: ids.brief,
            replay_source_brief_sha256: digest("brief"),
            replay_source_selected_candidate_id: ids.candidate,
            canonical_input_bytes: new TextEncoder().encode("{}"),
            canonical_request_bytes: new TextEncoder().encode("{}"),
          },
        ],
      }),
    });
    await expect(
      operatorRepository(pool).getClaimedRunInput(fence() as never),
    ).rejects.toBeInstanceOf(OperationInternalError);
  });

  it("rejects a replay projection with any missing binding", async () => {
    const complete = {
      run_id: ids.run,
      purpose: "replay",
      evaluation_time: new Date(databaseNow),
      policy_revision: "1",
      input_snapshot_id: ids.snapshot,
      input_sha256: digest("input"),
      input_row_count: "12",
      field_catalog_snapshot_id: ids.catalog,
      metric_contract_set_id: ids.contractSet,
      metric_contract_set_sha256: digest("contract"),
      ...vectorRow("generation_limit"),
      ...vectorRow("review_limit", 100),
      replay_source_run_id: ids.sourceRun,
      replay_source_result_count: 3,
      replay_source_head_sequence: "9",
      replay_source_head_sha256: digest("head"),
      replay_source_candidate_set_sha256: digest("set"),
      replay_source_bundle_id: ids.bundle,
      replay_source_bundle_sha256: digest("bundle"),
      replay_source_brief_id: ids.brief,
      replay_source_brief_sha256: digest("brief"),
      replay_source_selected_candidate_id: ids.candidate,
      canonical_input_bytes: new TextEncoder().encode("{}"),
      canonical_request_bytes: new TextEncoder().encode("{}"),
    };
    for (const key of [
      "replay_source_result_count",
      "replay_source_head_sequence",
      "replay_source_head_sha256",
      "replay_source_candidate_set_sha256",
      "replay_source_bundle_id",
      "replay_source_bundle_sha256",
      "replay_source_brief_id",
      "replay_source_brief_sha256",
      "replay_source_selected_candidate_id",
    ] as const) {
      const { pool } = harness({
        operation: () => ({
          rowCount: 1,
          rows: [{ ...complete, [key]: null }],
        }),
      });
      await expect(
        operatorRepository(pool).getClaimedRunInput(fence() as never),
      ).rejects.toBeInstanceOf(OperationInternalError);
    }
  });
});

describe("agent run repository: exact fixed SQL fixtures", () => {
  const tenantFixtures = {
    requestAgentRun:
      "05689b46f8dbb20fabd09e24ea9f42047e6d5ee6ee0cf44f0eeca26d1904317f",
    cancelAgentRun:
      "3166a6cf4b431d6a7375a84e6181484d39ec8ad1b80d20dfdb38944ba7304811",
    getAgentRun:
      "de3b461dfcff9029cb13cd0506f8a794edd4256097dc6262bcfc2b7b545dc55e",
    listAgentRunEvents:
      "113e12aec1d61e3c68490a2981ab64c0125bfb79415ae8e14247cb05a5271415",
    getAgentRunCheckpoint:
      "563bfbac95e5d82392eb58400843506e667b9ab3a844c3f2be9d5a669d0d1bef",
    getAgentCandidate:
      "4e9ccf4b15f3ce7ee15260281394e9ac558ebeddfbde9251b1ff5c6c0ae669c2",
  } as const;
  const operatorFixtures = {
    claimAgentRun:
      "c905b9e4bbb5918b3445f7c55c8a9f82f3d4a4de60218e97973fe48802ee26e8",
    getClaimedRunInput:
      "0ac85d9a3fb7c7d749826426cf045774e4f254e11dc9a7d7e07bc3e428ca4a88",
    cloneClaimedReplayPrerequisites:
      "cd730da15a0568b600c5731fb44f8dcfdefde2ee027a78e8900fca46ee1cbe88",
    listClaimedReplayResults:
      "530ec1c4bae2566a4a1ca0ba9c4189af06975c3f2e5b5bf2adec711978f6cb47",
    consumeReplayResult:
      "e973566aec5528140af4dc4ab9ae10b34e8629b1eb497238eb369c948b4dd5ae",
    writeCheckpoint:
      "a37e4f433b710016dfbeffc787ac35e25f5eb8fede8258c7ae5052d1c9715c1a",
    commitBrief:
      "c2c7fe9840ab8a07705a62d87d00e16fe90d77628153e54e1b39e7f834e0af64",
    commitCommonEvidenceBundle:
      "22280d964d27fb1876076ece840917725ca7049ca873f830d6761283910bb77b",
    reserveAttempt:
      "fe967b2f787d200f18872e6ba1d74adfb48b2febf97d0e712eeb31fb36c5ca3f",
    startAttempt:
      "b964a21a51c005a9382942313e1817a32997f73f393a37550cdf0a63b89e832a",
    authorizeAttemptInvocation:
      "a4337e818d3c20e68739d5cf9e726b0632f0e76050e13c8acada4eba15a94025",
    reconcileAttempt:
      "c6fda1d97dad4f998c71eeb7a569563c3f99a76e3c642cf94746332ee0b59732",
    releaseAttempt:
      "eb2f2db6c5a09806624e16da8caeaabfaa570e620006cca928fa64806887c747",
    commitCalculationGraph:
      "7d727bb6c33ebc15ceda562ab25060bbfc27a53a99db1c1ee90c3673dade4d0d",
    commitCandidate:
      "812de36ad5950acb7d2bcd0bb4c42948bff6976c2246601d9cc7f47fe5116e6e",
    commitValidationFindings:
      "93398bb72848c2bf5838dd18521242e35a2693900819d80b17a703731aa40ab9",
    closeCandidateSet:
      "2040f2146094aaba5986d62cb820e19eae4c6c21dd91e6b6e349d65c1897383f",
    commitCandidateClaims:
      "a560863097e0c52070784fe6483f572fceb7cf4aa4ae0e7a49b92412459db710",
    commitCandidateManifest:
      "371691788559a9e471cba08d9c040555f04b5dab660e4403e85f7576652db468",
    commitRunAbstention:
      "781ba0819892df2ad1ec4f94f4f15cbcec6b9cfd6a23ac9099fb601134fd884f",
    finalizeRanking:
      "b879effa96b20cfa1fb6100f9184f0784bb75392cb9e275970ee27de9adede1a",
    finishRun:
      "9f03c2783c22013dbdc67caaecee9bb82ef38774f176d5d8deebc1df61a992cf",
  } as const;

  it("matches all six tenant statements by full normalized SQL digest", async () => {
    const inputs: Record<string, Record<string, unknown>> = {
      requestAgentRun: requestInput(),
      cancelAgentRun: cancelInput(),
      getAgentRun: { sessionToken: issued("session"), runId: ids.run },
      listAgentRunEvents: {
        sessionToken: issued("session"),
        runId: ids.run,
        afterSequence: 0,
        limit: 100,
      },
      getAgentRunCheckpoint: {
        sessionToken: issued("session"),
        runId: ids.run,
      },
      getAgentCandidate: {
        sessionToken: issued("session"),
        runId: ids.run,
        candidateId: ids.candidate,
      },
    };
    for (const [method, expected] of Object.entries(tenantFixtures)) {
      const { pool, clients } = harness({
        operation: () => {
          throw databaseError("P1001");
        },
      });
      const repository = tenantRepository(pool) as unknown as Record<
        string,
        (input: unknown) => Promise<unknown>
      >;
      await expect(repository[method]!(inputs[method])).rejects.toBeInstanceOf(
        OperationDeniedError,
      );
      const sql = clients[0]!.calls[3]!.text;
      expect(normalizedSqlSha256(sql), method).toBe(expected);
      expect(sql).not.toContain(";");
    }
  });

  it("matches all twenty-two operator statements by full normalized SQL digest", async () => {
    const actual: Record<string, string> = {};
    for (const [method, expected] of Object.entries(operatorFixtures)) {
      const { pool, clients } = harness({
        operation: () => {
          throw databaseError("P1001");
        },
      });
      const repository = operatorRepository(pool) as unknown as Record<
        string,
        (input: unknown) => Promise<unknown>
      >;
      const input =
        method === "claimAgentRun"
          ? { claimRequestId: ids.claimRequest, leaseSeconds: 900 }
          : postClaimInput(method);
      await expect(repository[method]!(input)).rejects.toBeInstanceOf(
        OperationDeniedError,
      );
      const sql = clients[0]!.calls[3]!.text;
      actual[method] = normalizedSqlSha256(sql);
      expect(sql).not.toContain(";");
      expect(sql.match(/\bFROM dasher_run_api\.[a-z_]+\(/gu)).toHaveLength(1);
      void expected;
    }
    expect(actual).toEqual(operatorFixtures);
  });
});

describe("agent run repository: stateful retry and drift contracts", () => {
  const requestResult: PgCompatibleQueryResult = {
    rowCount: 1,
    rows: [
      {
        run_id: ids.run,
        run_revision: "1",
        state: "requested",
        policy_revision: "1",
        request_sha256: digest("request"),
      },
    ],
  };
  const cancelResult: PgCompatibleQueryResult = {
    rowCount: 1,
    rows: [
      {
        run_id: ids.run,
        run_revision: "5",
        state: "cancelled",
        event_sequence: "5",
        event_sha256: digest("cancel-event"),
      },
    ],
  };

  it("replays the revision-one request after advancement and denies every bound-input drift", async () => {
    let original: readonly unknown[] | undefined;
    let advanced = false;
    let accessible = true;
    const { pool, clients } = harness({
      operation: (_text, values) => {
        if (!accessible) throw databaseError("P1001");
        const bindings = values.slice(0, 7).concat(values[10], values[11]);
        if (original === undefined) {
          original = bindings;
          advanced = true;
          return requestResult;
        }
        if (
          bindings.length !== original.length ||
          bindings.some((value, index) =>
            value instanceof Uint8Array &&
            original![index] instanceof Uint8Array
              ? !value.every(
                  (byte, offset) =>
                    byte === (original![index] as Uint8Array)[offset],
                )
              : value !== original![index],
          )
        ) {
          throw databaseError("P1001");
        }
        return requestResult;
      },
    });
    const repository = tenantRepository(pool);
    const first = await repository.requestAgentRun(requestInput() as never);
    const replay = await repository.requestAgentRun(requestInput() as never);
    expect(advanced).toBe(true);
    expect(replay).toEqual(first);
    expect(replay.runRevision).toBe(1);
    expect(replay.state).toBe("requested");

    const drifts = [
      { dashboardId: ids.sourceRun },
      { inputSnapshotId: ids.sourceRun },
      { runRequestId: ids.sourceRun },
      { expectedLifecycleRevision: 4 },
      { expectedInputSha256: digest("drift-input") },
      { idempotencySha256: digest("drift-idempotency") },
      { purpose: "replay", replaySourceRunId: ids.sourceRun },
    ] as const;
    for (const drift of drifts) {
      await expect(
        repository.requestAgentRun(requestInput(drift) as never),
      ).rejects.toBeInstanceOf(OperationDeniedError);
      expect(clients.at(-1)!.calls.at(-1)!.text).toBe("ROLLBACK");
    }

    const deploymentDrift = new AgentRunRepository({
      pool,
      keyRing: keyRing(),
      deploymentRevision: `${deploymentRevision}-drift`,
      uuidSource: uuidSource(),
    });
    await expect(
      deploymentDrift.requestAgentRun(requestInput() as never),
    ).rejects.toBeInstanceOf(OperationDeniedError);

    accessible = false;
    await expect(
      repository.requestAgentRun(requestInput() as never),
    ).rejects.toBeInstanceOf(OperationDeniedError);
  });

  it("replays a stored cancellation before terminal checks and permanently reserves its audit id", async () => {
    let original: readonly unknown[] | undefined;
    let contentPurged = false;
    let metadataAgedOut = false;
    const { pool } = harness({
      operation: (_text, values) => {
        const identity = [values[0], values[1], values[3], values[6]];
        if (original === undefined) {
          original = identity;
          return cancelResult;
        }
        const exact = identity.every(
          (value, index) => value === original![index],
        );
        if (!exact || metadataAgedOut) throw databaseError("P1001");
        if (contentPurged) throw databaseError("P1001");
        return cancelResult;
      },
    });
    const repository = tenantRepository(pool);
    const first = await repository.cancelAgentRun(cancelInput() as never);
    const replay = await repository.cancelAgentRun(cancelInput() as never);
    expect(replay).toEqual(first);
    expect(replay.eventSequence).toBe(5);

    await expect(
      repository.cancelAgentRun(
        cancelInput({ expectedRunRevision: 5 }) as never,
      ),
    ).rejects.toBeInstanceOf(OperationDeniedError);
    await expect(
      repository.cancelAgentRun(cancelInput({ runId: ids.sourceRun }) as never),
    ).rejects.toBeInstanceOf(OperationDeniedError);

    contentPurged = true;
    await expect(
      repository.cancelAgentRun(cancelInput() as never),
    ).rejects.toBeInstanceOf(OperationDeniedError);
    metadataAgedOut = true;
    await expect(
      repository.cancelAgentRun(cancelInput({ runId: ids.sourceRun }) as never),
    ).rejects.toBeInstanceOf(OperationDeniedError);
  });

  it("replays historical ordinary and NULL-token terminalized claims exactly and denies drift", async () => {
    const ordinary = {
      rowCount: 1,
      rows: [
        {
          status: "claimed",
          organization_id: ids.organization,
          dashboard_id: ids.dashboard,
          run_id: ids.run,
          run_revision: "2",
          state: "authorized",
          lease_epoch: "1",
          attempt_token: digest("original-token"),
          lease_expires_at: new Date("2026-08-04T00:01:00.000Z"),
          policy_revision: "1",
          input_sha256: digest("input"),
        },
      ],
    } satisfies PgCompatibleQueryResult;
    const terminal = {
      rowCount: 1,
      rows: [
        {
          ...ordinary.rows[0],
          status: "terminalized_indeterminate",
          run_revision: "7",
          state: "failed",
          lease_epoch: "2",
          attempt_token: null,
          lease_expires_at: null,
          input_sha256: null,
        },
      ],
    } satisfies PgCompatibleQueryResult;
    for (const fixture of [ordinary, terminal] as const) {
      let lease: unknown;
      const { pool } = harness({
        operation: (_text, values) => {
          if (lease === undefined) lease = values[1];
          else if (values[1] !== lease) throw databaseError("P1001");
          return fixture;
        },
      });
      const repository = operatorRepository(pool);
      const first = await repository.claimAgentRun({
        claimRequestId: ids.claimRequest,
        leaseSeconds: 60,
      });
      const replay = await repository.claimAgentRun({
        claimRequestId: ids.claimRequest,
        leaseSeconds: 60,
      });
      expect(replay).toEqual(first);
      if (replay.status === "claimed") {
        expect(replay.lease.attemptToken).toEqual(digest("original-token"));
      } else {
        expect(replay.status).toBe("terminalized_indeterminate");
        if (replay.status !== "terminalized_indeterminate") {
          throw new Error("unexpected no-claim replay");
        }
        expect(replay.terminal).not.toHaveProperty("attemptToken");
      }
      await expect(
        repository.claimAgentRun({
          claimRequestId: ids.claimRequest,
          leaseSeconds: 61,
        }),
      ).rejects.toBeInstanceOf(OperationDeniedError);
    }
  });

  it.each([
    ["stale epoch", "P1002", OperationConflictError],
    ["stale token", "P1001", OperationDeniedError],
    ["lease expiry", "P1001", OperationDeniedError],
    ["cancellation", "P1002", OperationConflictError],
    ["principal revocation", "P1001", OperationDeniedError],
    ["wrong policy", "P1001", OperationDeniedError],
    ["wrong input digest", "P1001", OperationDeniedError],
    ["budget conflict", "P1002", OperationConflictError],
  ] as const)(
    "normalizes %s, rolls back, and reuses the pool with exact fence parameter order",
    async (_reason, code, ErrorType) => {
      let calls = 0;
      const { pool, clients } = harness({
        operation: () => {
          calls += 1;
          if (calls === 1) throw databaseError(code);
          return {
            rowCount: 1,
            rows: [{ ...mutationRow(), state: "failed", lease_epoch: "2" }],
          };
        },
      });
      const repository = operatorRepository(pool);
      const input = postClaimInput("finishRun");
      await expect(repository.finishRun(input as never)).rejects.toBeInstanceOf(
        ErrorType,
      );
      expect(clients[0]!.calls.at(-1)!.text).toBe("ROLLBACK");
      expect(clients[0]!.releases).toEqual([undefined]);
      const retried = await repository.finishRun(input as never);
      expect(retried.state).toBe("failed");
      expect(clients[1]!.calls[3]!.values.slice(0, 3)).toEqual([
        ids.run,
        1,
        digest("token"),
      ]);
      expect(clients[1]!.releases).toEqual([undefined]);
    },
  );
});
