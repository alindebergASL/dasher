import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import * as publicApi from "./index.js";
import { DashboardLifecycleRepository } from "./dashboard-lifecycle-repository.js";
import {
  OperationConflictError,
  OperationDeniedError,
  OperationInternalError,
  type PgCompatibleClient,
  type PgCompatiblePool,
  type PgCompatibleQueryResult,
} from "./invitation-repository.js";
import { SecretKeyRing } from "./secrets.js";

const ids = {
  dashboardA: "10000000-0000-4000-8000-000000000001",
  dashboardB: "10000000-0000-4000-8000-000000000002",
  versionA: "10000000-0000-4000-8000-000000000003",
  versionB: "10000000-0000-4000-8000-000000000004",
  snapshotA: "10000000-0000-4000-8000-000000000005",
  snapshotB: "10000000-0000-4000-8000-000000000006",
  evidenceA: "10000000-0000-4000-8000-000000000007",
  evidenceB: "10000000-0000-4000-8000-000000000008",
  artifactA: "10000000-0000-4000-8000-000000000009",
  promotion: "10000000-0000-4000-8000-00000000000a",
  session: "20000000-0000-4000-8000-000000000001",
  user: "20000000-0000-4000-8000-000000000002",
  organization: "20000000-0000-4000-8000-000000000003",
  membership: "20000000-0000-4000-8000-000000000004",
} as const;

const deploymentRevision = "task-8c-test";
const databaseNow = new Date("2026-08-03T00:00:00.000Z");
const idleExpiresAt = new Date("2026-08-03T00:30:00.000Z");
const absoluteExpiresAt = new Date("2026-08-10T00:00:00.000Z");
const createdAt = new Date("2026-08-02T12:00:00.000Z");
const observedAt = new Date("2026-08-02T10:00:00.000Z");
const retrievedAt = new Date("2026-08-02T10:05:00.000Z");
const expiresAt = new Date("2026-08-04T00:00:00.000Z");
const canonicalSpecBytes = new TextEncoder().encode("{}");
const canonicalSpecSha256 = digestBytes(canonicalSpecBytes);

function generatedUuid(index: number): string {
  return `30000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function generatedUuids(count = 32): readonly string[] {
  return Array.from({ length: count }, (_, index) => generatedUuid(index + 1));
}

function digest(seed: string): Uint8Array {
  return digestBytes(new TextEncoder().encode(seed));
}

function digestBytes(value: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(value).digest());
}

function keyRing(): SecretKeyRing {
  return new SecretKeyRing(
    {
      currentVersion: 1,
      verificationKeys: [{ version: 1, key: digest("key") }],
    },
    { randomBytes: () => digest("session") },
  );
}

function contextResult(
  overrides: Record<string, unknown> = {},
): PgCompatibleQueryResult {
  return oneRow({
    session_id: ids.session,
    user_id: ids.user,
    organization_id: ids.organization,
    membership_id: ids.membership,
    authority_revision: "7",
    idle_expires_at: new Date(idleExpiresAt),
    absolute_expires_at: new Date(absoluteExpiresAt),
    database_now: new Date(databaseNow),
    ...overrides,
  });
}

function oneRow(row: Record<string, unknown>): PgCompatibleQueryResult {
  return { rowCount: 1, rows: [row] };
}

function summaryRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    dashboard_id: ids.dashboardA,
    title: "General dashboard",
    current_kind: "disposable",
    lifecycle_state: "active",
    lifecycle_revision: "3",
    effective_expires_at: new Date(expiresAt),
    head_version_id: ids.versionA,
    ...overrides,
  };
}

function versionRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    dashboard_id: ids.dashboardA,
    version_id: ids.versionA,
    parent_version_id: null,
    canonical_spec_bytes: new Uint8Array(canonicalSpecBytes),
    canonical_spec_sha256: new Uint8Array(canonicalSpecSha256),
    validation_state: "validated",
    validation_sha256: digest("validation"),
    planner_provenance_sha256: digest("planner"),
    policy_revision: "1",
    registry_revision: "2",
    calculation_graph_sha256: null,
    created_at: new Date(createdAt),
    ...overrides,
  };
}

function evidenceRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    dashboard_id: ids.dashboardA,
    version_id: ids.versionA,
    evidence_id: ids.evidenceA,
    evidence_kind: "typed_value",
    content_sha256: digest("evidence"),
    observed_at: new Date(observedAt),
    retrieved_at: new Date(retrievedAt),
    ...overrides,
  };
}

function lineageRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    dashboard_id: ids.dashboardA,
    version_id: ids.versionA,
    parent_version_id: null,
    snapshot_id: ids.snapshotA,
    evidence_id: ids.evidenceA,
    artifact_id: ids.artifactA,
    artifact_ownership_class: "dashboard_owned",
    ...overrides,
  };
}

function creationRow(
  dashboardId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    dashboard_id: dashboardId,
    created_at: new Date(createdAt),
    effective_expires_at: null,
    effective_ttl_seconds: null,
    used_organization_default: false,
    lifecycle_policy_seeded: false,
    lifecycle_policy_revision: "1",
    default_disposable_ttl_seconds: 86_400,
    retention_policy_revision: "1",
    ...overrides,
  };
}

function adminRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    dashboard_id: ids.dashboardA,
    lifecycle_state: "active",
    lifecycle_revision: "3",
    capability_epoch: "1",
    cache_epoch: "1",
    access_revoked_at: null,
    purge_after: null,
    purge_started_at: null,
    purged_at: null,
    active_hold_count: "0",
    cleanup_step: null,
    ...overrides,
  };
}

interface QueryCall {
  readonly text: string;
  readonly values?: readonly unknown[];
}

type FailureStage =
  "begin" | "set_local" | "initialize" | "operation" | "rollback" | "commit";

interface FakeClientOptions {
  readonly context?: () => PgCompatibleQueryResult;
  readonly operation?: (
    text: string,
    values: readonly unknown[],
  ) => PgCompatibleQueryResult;
  readonly failure?: {
    readonly stage: FailureStage;
    readonly error: unknown;
  };
  readonly releaseFailure?: boolean;
  readonly events?: string[];
}

class FakeClient implements PgCompatibleClient {
  readonly calls: QueryCall[] = [];
  readonly releases: Array<boolean | undefined> = [];
  readonly #options: FakeClientOptions;

  constructor(options: FakeClientOptions = {}) {
    this.#options = options;
  }

  async query(
    text: string,
    values?: unknown[],
  ): Promise<PgCompatibleQueryResult> {
    this.calls.push({ text, values });
    this.#options.events?.push(text);
    const stage =
      text === "BEGIN"
        ? "begin"
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
    if (stage === "initialize") {
      return (this.#options.context ?? contextResult)();
    }
    if (stage === "operation") {
      return (
        this.#options.operation?.(text, values ?? []) ?? {
          rowCount: 0,
          rows: [],
        }
      );
    }
    return { rowCount: null, rows: [] };
  }

  release(destroy?: boolean): void {
    this.releases.push(destroy);
    this.#options.events?.push(`release:${String(destroy)}`);
    if (this.#options.releaseFailure && destroy === undefined) {
      throw new Error("hostile release");
    }
  }
}

function deterministicUuidSource(values: readonly string[]): () => string {
  let index = 0;
  return () => values[index++] ?? generatedUuid(10_000 + index++);
}

interface RepositoryFixture {
  readonly repository: DashboardLifecycleRepository;
  readonly sessionToken: string;
  readonly currentCsrfValue: string;
  readonly pool: PgCompatiblePool & { connect: ConnectMock };
}

type ConnectMock = ReturnType<typeof vi.fn<() => Promise<PgCompatibleClient>>>;

function repositoryFixture(
  client: PgCompatibleClient,
  uuidValues: readonly string[] = generatedUuids(),
  connect?: ConnectMock,
): RepositoryFixture {
  const ring = keyRing();
  const sessionToken = ring.issue("session").wireValue;
  const currentCsrfValue = ring.issue("csrf").wireValue;
  const pool = {
    connect: connect ?? vi.fn(async () => client),
  };
  return {
    repository: new DashboardLifecycleRepository({
      pool,
      keyRing: ring,
      deploymentRevision,
      uuidSource: deterministicUuidSource(uuidValues),
    }),
    sessionToken,
    currentCsrfValue,
    pool,
  };
}

function operationCall(client: FakeClient): QueryCall {
  const call = client.calls[3];
  if (call === undefined) throw new Error("missing operation call");
  return call;
}

function expectProtocol(
  fixture: RepositoryFixture,
  client: FakeClient,
  functionName: string,
): void {
  expect(fixture.pool.connect).toHaveBeenCalledTimes(1);
  expect(client.calls).toHaveLength(5);
  expect(client.calls[0]?.text).toBe("BEGIN");
  expect(client.calls[1]?.text).toBe("SET LOCAL search_path = pg_catalog");
  expect(client.calls[2]?.text).toContain("dasher_api.initialize_context(");
  expect(client.calls[3]?.text).toContain(`dasher_api.${functionName}(`);
  expect(client.calls[4]?.text).toBe("COMMIT");
  expect(
    client.calls.filter(({ text }) => text.includes("dasher_api.")),
  ).toHaveLength(2);
  expect(client.releases).toEqual([undefined]);
}

describe("DashboardLifecycleRepository fixed method surface", () => {
  it("uses the exact fixed projection identities, casts, parameter order, and result shapes", async () => {
    const projectionCases: Array<{
      readonly name: string;
      readonly invoke: (fixture: RepositoryFixture) => Promise<unknown>;
      readonly operation: PgCompatibleQueryResult;
      readonly casts: readonly string[];
      readonly values: readonly unknown[];
      readonly expected: unknown;
    }> = [
      {
        name: "list_dashboards",
        invoke: ({ repository, sessionToken }) =>
          repository.listDashboards({ sessionToken, limit: 10 }),
        operation: {
          rowCount: 2,
          rows: [
            summaryRow(),
            summaryRow({
              dashboard_id: ids.dashboardB,
              title: "Second tenant dashboard",
              current_kind: "durable",
              lifecycle_state: "draft",
              lifecycle_revision: "0",
              effective_expires_at: null,
              head_version_id: null,
            }),
          ],
        },
        casts: ["$1::integer"],
        values: [10],
        expected: [
          expect.objectContaining({ dashboardId: ids.dashboardA }),
          expect.objectContaining({
            dashboardId: ids.dashboardB,
            lifecycleRevision: 0,
          }),
        ],
      },
      {
        name: "get_dashboard_summary",
        invoke: ({ repository, sessionToken }) =>
          repository.getDashboardSummary({
            sessionToken,
            dashboardId: ids.dashboardA,
          }),
        operation: oneRow(summaryRow()),
        casts: ["$1::uuid"],
        values: [ids.dashboardA],
        expected: expect.objectContaining({
          dashboardId: ids.dashboardA,
          currentKind: "disposable",
          lifecycleState: "active",
          lifecycleRevision: 3,
        }),
      },
      {
        name: "get_dashboard_head",
        invoke: ({ repository, sessionToken }) =>
          repository.getDashboardHead({
            sessionToken,
            dashboardId: ids.dashboardA,
          }),
        operation: oneRow(versionRow()),
        casts: ["$1::uuid"],
        values: [ids.dashboardA],
        expected: expect.objectContaining({
          dashboardId: ids.dashboardA,
          versionId: ids.versionA,
          validationState: "validated",
        }),
      },
      {
        name: "get_dashboard_version",
        invoke: ({ repository, sessionToken }) =>
          repository.getDashboardVersion({
            sessionToken,
            dashboardId: ids.dashboardA,
            versionId: ids.versionA,
          }),
        operation: oneRow(versionRow()),
        casts: ["$1::uuid", "$2::uuid"],
        values: [ids.dashboardA, ids.versionA],
        expected: expect.objectContaining({ versionId: ids.versionA }),
      },
      {
        name: "get_dashboard_evidence",
        invoke: ({ repository, sessionToken }) =>
          repository.getDashboardEvidence({
            sessionToken,
            dashboardId: ids.dashboardA,
            versionId: ids.versionA,
          }),
        operation: oneRow(evidenceRow()),
        casts: ["$1::uuid", "$2::uuid"],
        values: [ids.dashboardA, ids.versionA],
        expected: [
          expect.objectContaining({
            evidenceId: ids.evidenceA,
            evidenceKind: "typed_value",
          }),
        ],
      },
      {
        name: "get_dashboard_lineage",
        invoke: ({ repository, sessionToken }) =>
          repository.getDashboardLineage({
            sessionToken,
            dashboardId: ids.dashboardA,
            versionId: ids.versionA,
          }),
        operation: oneRow(lineageRow()),
        casts: ["$1::uuid", "$2::uuid"],
        values: [ids.dashboardA, ids.versionA],
        expected: [
          {
            dashboardId: ids.dashboardA,
            versionId: ids.versionA,
            parentVersionId: null,
            snapshotId: ids.snapshotA,
            evidenceId: ids.evidenceA,
            artifactId: ids.artifactA,
            artifactOwnershipClass: "dashboard_owned",
          },
        ],
      },
      {
        name: "get_dashboard_admin_status",
        invoke: ({ repository, sessionToken }) =>
          repository.getDashboardAdminStatus({
            sessionToken,
            dashboardId: ids.dashboardA,
          }),
        operation: oneRow(adminRow()),
        casts: ["$1::uuid"],
        values: [ids.dashboardA],
        expected: expect.objectContaining({
          dashboardId: ids.dashboardA,
          capabilityEpoch: 1,
          cacheEpoch: 1,
          activeHoldCount: 0,
          cleanupStep: null,
        }),
      },
    ];

    for (const testCase of projectionCases) {
      const client = new FakeClient({ operation: () => testCase.operation });
      const fixture = repositoryFixture(client);
      await expect(testCase.invoke(fixture), testCase.name).resolves.toEqual(
        testCase.expected,
      );
      expectProtocol(fixture, client, testCase.name);
      const operation = operationCall(client);
      expect(operation.values).toEqual(testCase.values);
      for (const cast of testCase.casts) expect(operation.text).toContain(cast);
      expect(client.calls[2]?.values?.[2]).toBe(generatedUuid(1));
    }
  });

  it("keeps manager and admin drill-down projections fixed, revision-level, and lifecycle-literal", async () => {
    const summaryFixture = repositoryFixture(
      new FakeClient({ operation: () => oneRow(summaryRow()) }),
    );
    const summary = await summaryFixture.repository.getDashboardSummary({
      sessionToken: summaryFixture.sessionToken,
      dashboardId: ids.dashboardA,
    });
    expect(Object.keys(summary)).toEqual([
      "dashboardId",
      "title",
      "currentKind",
      "lifecycleState",
      "lifecycleRevision",
      "headVersionId",
      "effectiveExpiresAt",
    ]);
    expect(summary).toMatchObject({
      dashboardId: ids.dashboardA,
      title: "General dashboard",
      currentKind: "disposable",
      lifecycleState: "active",
      lifecycleRevision: 3,
      headVersionId: ids.versionA,
      effectiveExpiresAt: expiresAt,
    });
    expect(summary.lifecycleState).not.toBe("Published");

    const headFixture = repositoryFixture(
      new FakeClient({ operation: () => oneRow(versionRow()) }),
    );
    const head = await headFixture.repository.getDashboardHead({
      sessionToken: headFixture.sessionToken,
      dashboardId: ids.dashboardA,
    });
    expect(Object.keys(head)).toEqual([
      "dashboardId",
      "versionId",
      "parentVersionId",
      "validationState",
      "policyRevision",
      "registryRevision",
      "canonicalSpecBytes",
      "canonicalSpecSha256",
      "validationSha256",
      "plannerProvenanceSha256",
      "calculationGraphSha256",
      "createdAt",
    ]);
    expect(head.versionId).toBe(summary.headVersionId);
    expect(head.createdAt).toEqual(createdAt);

    const evidenceFixture = repositoryFixture(
      new FakeClient({ operation: () => oneRow(evidenceRow()) }),
    );
    const evidence = await evidenceFixture.repository.getDashboardEvidence({
      sessionToken: evidenceFixture.sessionToken,
      dashboardId: ids.dashboardA,
      versionId: head.versionId,
    });
    expect(Object.keys(evidence[0] ?? {})).toEqual([
      "dashboardId",
      "versionId",
      "evidenceId",
      "evidenceKind",
      "contentSha256",
      "observedAt",
      "retrievedAt",
    ]);
    expect(evidence[0]).toMatchObject({
      dashboardId: ids.dashboardA,
      versionId: head.versionId,
      evidenceId: ids.evidenceA,
      observedAt,
      retrievedAt,
    });
    expect(Object.keys(evidence[0] ?? {})).not.toContain("claimId");

    const sharedArtifactId = generatedUuid(91);
    const lineageFixture = repositoryFixture(
      new FakeClient({
        operation: () => ({
          rowCount: 2,
          rows: [
            lineageRow(),
            lineageRow({
              artifact_id: sharedArtifactId,
              artifact_ownership_class: "shared",
            }),
          ],
        }),
      }),
    );
    const lineage = await lineageFixture.repository.getDashboardLineage({
      sessionToken: lineageFixture.sessionToken,
      dashboardId: ids.dashboardA,
      versionId: head.versionId,
    });
    expect(Object.keys(lineage[0] ?? {})).toEqual([
      "dashboardId",
      "versionId",
      "parentVersionId",
      "snapshotId",
      "evidenceId",
      "artifactId",
      "artifactOwnershipClass",
    ]);
    expect(
      lineage.map(({ artifactOwnershipClass }) => artifactOwnershipClass),
    ).toEqual(["dashboard_owned", "shared"]);
    expect(lineage.every(({ versionId }) => versionId === head.versionId)).toBe(
      true,
    );

    const accessRevokedAt = new Date("2026-08-03T01:00:00.000Z");
    const purgeAfter = new Date("2026-09-02T01:00:00.000Z");
    const adminFixture = repositoryFixture(
      new FakeClient({
        operation: () =>
          oneRow(
            adminRow({
              lifecycle_state: "access_revoked",
              lifecycle_revision: "5",
              capability_epoch: "3",
              cache_epoch: "3",
              access_revoked_at: accessRevokedAt,
              purge_after: purgeAfter,
              cleanup_step: "access_revoked",
            }),
          ),
      }),
    );
    const admin = await adminFixture.repository.getDashboardAdminStatus({
      sessionToken: adminFixture.sessionToken,
      dashboardId: ids.dashboardA,
    });
    expect(Object.keys(admin)).toEqual([
      "dashboardId",
      "lifecycleState",
      "lifecycleRevision",
      "capabilityEpoch",
      "cacheEpoch",
      "activeHoldCount",
      "cleanupStep",
      "accessRevokedAt",
      "purgeAfter",
      "purgeStartedAt",
      "purgedAt",
    ]);
    expect(admin).toMatchObject({
      lifecycleState: "access_revoked",
      lifecycleRevision: 5,
      capabilityEpoch: 3,
      cacheEpoch: 3,
      accessRevokedAt,
      purgeAfter,
      cleanupStep: "access_revoked",
    });

    const typesSource = readFileSync(
      new URL("./dashboard-lifecycle-types.ts", import.meta.url),
      "utf8",
    );
    expect(typesSource).not.toMatch(/["']Published["']/);
    expect(typesSource).not.toMatch(/claimId|claimLevelEvidence/);
    expect(typesSource.match(/\bretention[A-Za-z]*/g)).toEqual([
      "retentionPolicyRevision",
    ]);
  });

  it("uses exact mutation identities, generated IDs, explicit casts, and canonical argument order", async () => {
    const validationSha256 = digest("validation-input");
    const plannerSha256 = digest("planner-input");
    const graphSha256 = digest("graph-input");
    const contentSha256 = digest("content-input");
    const rationaleSha256 = digest("rationale-input");
    const provenanceSha256 = digest("restore-input");
    const cases: Array<{
      readonly name: string;
      readonly invoke: (fixture: RepositoryFixture) => Promise<unknown>;
      readonly operation: (
        text: string,
        values: readonly unknown[],
      ) => PgCompatibleQueryResult;
      readonly expectedValues: readonly unknown[];
      readonly expected: unknown;
      readonly casts: readonly string[];
    }> = [
      {
        name: "create_dashboard",
        invoke: ({ repository, sessionToken, currentCsrfValue }) =>
          repository.createDashboard({
            sessionToken,
            currentCsrfValue,
            title: "Durable board",
            kind: "durable",
          }),
        operation: (_text, values) => oneRow(creationRow(values[0] as string)),
        expectedValues: [
          generatedUuid(2),
          "Durable board",
          "durable",
          null,
          false,
          generatedUuid(3),
          generatedUuid(4),
          1,
          expect.any(Uint8Array),
          deploymentRevision,
        ],
        expected: {
          dashboardId: generatedUuid(2),
          createdAt,
          effectiveExpiresAt: null,
          effectiveTtlSeconds: null,
          usedOrganizationDefault: false,
          lifecyclePolicySeeded: false,
          lifecyclePolicyRevision: 1,
          defaultDisposableTtlSeconds: 86_400,
          retentionPolicyRevision: 1,
        },
        casts: [
          "$1::uuid",
          "$2::text",
          "$3::text",
          "$4::integer",
          "$5::boolean",
          "$6::uuid",
          "$7::uuid",
          "$8::smallint",
          "$9::bytea",
          "$10::text",
        ],
      },
      {
        name: "create_evidence_record",
        invoke: ({ repository, sessionToken, currentCsrfValue }) =>
          repository.createEvidenceRecord({
            sessionToken,
            currentCsrfValue,
            dashboardId: ids.dashboardA,
            versionId: ids.versionA,
            snapshotId: ids.snapshotA,
            evidenceKind: "event_record",
            coordinates: "ledger:month=2026-07",
            contentSha256,
            observedAt,
            retrievedAt,
          }),
        operation: () => oneRow({ acknowledged: 1 }),
        expectedValues: [
          ids.dashboardA,
          ids.versionA,
          generatedUuid(2),
          ids.snapshotA,
          generatedUuid(3),
          "event_record",
          "ledger:month=2026-07",
          contentSha256,
          observedAt,
          retrievedAt,
          generatedUuid(4),
          1,
          expect.any(Uint8Array),
          deploymentRevision,
        ],
        expected: { evidenceId: generatedUuid(2) },
        casts: [
          "$1::uuid",
          "$2::uuid",
          "$3::uuid",
          "$4::uuid",
          "$5::uuid",
          "$6::text",
          "$7::text",
          "$8::bytea",
          "$9::timestamptz",
          "$10::timestamptz",
          "$11::uuid",
          "$12::smallint",
          "$13::bytea",
          "$14::text",
        ],
      },
      {
        name: "create_dashboard_version",
        invoke: ({ repository, sessionToken, currentCsrfValue }) =>
          repository.createDashboardVersion({
            sessionToken,
            currentCsrfValue,
            dashboardId: ids.dashboardA,
            parentVersionId: null,
            canonicalSpecBytes,
            canonicalSpecSha256,
            validationSha256,
            plannerProvenanceSha256: plannerSha256,
            policyRevision: 1,
            registryRevision: 2,
            calculationGraphSha256: graphSha256,
            snapshotIds: [ids.snapshotA],
            evidenceIds: [ids.evidenceA],
          }),
        operation: (_text, values) => oneRow({ version_id: values[1] }),
        expectedValues: [
          ids.dashboardA,
          generatedUuid(2),
          null,
          canonicalSpecBytes,
          canonicalSpecSha256,
          validationSha256,
          plannerSha256,
          1,
          2,
          graphSha256,
          [ids.snapshotA],
          [generatedUuid(3)],
          [ids.evidenceA],
          [generatedUuid(4)],
          generatedUuid(5),
          1,
          expect.any(Uint8Array),
          deploymentRevision,
        ],
        expected: { versionId: generatedUuid(2) },
        casts: [
          "$1::uuid",
          "$2::uuid",
          "$3::uuid",
          "$4::bytea",
          "$5::bytea",
          "$6::bytea",
          "$7::bytea",
          "$8::bigint",
          "$9::bigint",
          "$10::bytea",
          "$11::uuid[]",
          "$12::uuid[]",
          "$13::uuid[]",
          "$14::uuid[]",
          "$15::uuid",
          "$16::smallint",
          "$17::bytea",
          "$18::text",
        ],
      },
      {
        name: "compare_and_swap_dashboard_head",
        invoke: ({ repository, sessionToken, currentCsrfValue }) =>
          repository.compareAndSwapDashboardHead({
            sessionToken,
            currentCsrfValue,
            dashboardId: ids.dashboardA,
            expectedHeadVersionId: null,
            newHeadVersionId: ids.versionA,
            expectedLifecycleRevision: 0,
          }),
        operation: () => oneRow({ acknowledged: 1 }),
        expectedValues: [
          ids.dashboardA,
          null,
          ids.versionA,
          0,
          generatedUuid(2),
          1,
          expect.any(Uint8Array),
          deploymentRevision,
        ],
        expected: { lifecycleEventId: generatedUuid(2) },
        casts: [
          "$1::uuid",
          "$2::uuid",
          "$3::uuid",
          "$4::bigint",
          "$5::uuid",
          "$6::smallint",
          "$7::bytea",
          "$8::text",
        ],
      },
      {
        name: "request_dashboard_promotion",
        invoke: ({ repository, sessionToken, currentCsrfValue }) =>
          repository.requestDashboardPromotion({
            sessionToken,
            currentCsrfValue,
            dashboardId: ids.dashboardA,
            expectedLifecycleRevision: 1,
            rationaleSha256,
          }),
        operation: (_text, values) =>
          oneRow({ promotion_request_id: values[1] }),
        expectedValues: [
          ids.dashboardA,
          generatedUuid(2),
          1,
          rationaleSha256,
          generatedUuid(3),
          1,
          expect.any(Uint8Array),
          deploymentRevision,
        ],
        expected: { promotionRequestId: generatedUuid(2) },
        casts: [
          "$1::uuid",
          "$2::uuid",
          "$3::bigint",
          "$4::bytea",
          "$5::uuid",
          "$6::smallint",
          "$7::bytea",
          "$8::text",
        ],
      },
      {
        name: "decide_dashboard_promotion",
        invoke: ({ repository, sessionToken, currentCsrfValue }) =>
          repository.decideDashboardPromotion({
            sessionToken,
            currentCsrfValue,
            promotionRequestId: ids.promotion,
            expectedLifecycleRevision: 1,
            decision: "approved",
          }),
        operation: () => oneRow({ acknowledged: 1 }),
        expectedValues: [
          ids.promotion,
          1,
          "approved",
          generatedUuid(2),
          generatedUuid(3),
          1,
          expect.any(Uint8Array),
          deploymentRevision,
        ],
        expected: {
          decision: "approved",
          lifecycleEventId: generatedUuid(2),
        },
        casts: [
          "$1::uuid",
          "$2::bigint",
          "$3::text",
          "$4::uuid",
          "$5::uuid",
          "$6::smallint",
          "$7::bytea",
          "$8::text",
        ],
      },
      {
        name: "set_dashboard_archive",
        invoke: ({ repository, sessionToken, currentCsrfValue }) =>
          repository.setDashboardArchive({
            sessionToken,
            currentCsrfValue,
            dashboardId: ids.dashboardA,
            archived: true,
            expectedLifecycleRevision: 2,
          }),
        operation: () => oneRow({ acknowledged: 1 }),
        expectedValues: [
          ids.dashboardA,
          true,
          2,
          generatedUuid(2),
          1,
          expect.any(Uint8Array),
          deploymentRevision,
        ],
        expected: { lifecycleEventId: generatedUuid(2) },
        casts: [
          "$1::uuid",
          "$2::boolean",
          "$3::bigint",
          "$4::uuid",
          "$5::smallint",
          "$6::bytea",
          "$7::text",
        ],
      },
      {
        name: "delete_dashboard",
        invoke: ({ repository, sessionToken, currentCsrfValue }) =>
          repository.deleteDashboard({
            sessionToken,
            currentCsrfValue,
            dashboardId: ids.dashboardA,
            expectedLifecycleRevision: 3,
          }),
        operation: () => oneRow({ acknowledged: 1 }),
        expectedValues: [
          ids.dashboardA,
          3,
          generatedUuid(2),
          1,
          expect.any(Uint8Array),
          deploymentRevision,
        ],
        expected: { lifecycleEventId: generatedUuid(2) },
        casts: [
          "$1::uuid",
          "$2::bigint",
          "$3::uuid",
          "$4::smallint",
          "$5::bytea",
          "$6::text",
        ],
      },
      {
        name: "restore_dashboard_as_new",
        invoke: ({ repository, sessionToken, currentCsrfValue }) =>
          repository.restoreDashboardAsNew({
            sessionToken,
            currentCsrfValue,
            sourceDashboardId: ids.dashboardA,
            sourceVersionId: ids.versionA,
            expectedSourceLifecycleRevision: 4,
            title: "Restored durable board",
            provenanceSha256,
          }),
        operation: () => oneRow({ acknowledged: 1 }),
        expectedValues: [
          ids.dashboardA,
          ids.versionA,
          4,
          generatedUuid(2),
          generatedUuid(3),
          generatedUuid(4),
          "Restored durable board",
          provenanceSha256,
          generatedUuid(5),
          1,
          expect.any(Uint8Array),
          deploymentRevision,
        ],
        expected: {
          dashboardId: generatedUuid(2),
          versionId: generatedUuid(3),
        },
        casts: [
          "$1::uuid",
          "$2::uuid",
          "$3::bigint",
          "$4::uuid",
          "$5::uuid",
          "$6::uuid",
          "$7::text",
          "$8::bytea",
          "$9::uuid",
          "$10::smallint",
          "$11::bytea",
          "$12::text",
        ],
      },
    ];

    for (const testCase of cases) {
      const client = new FakeClient({ operation: testCase.operation });
      const fixture = repositoryFixture(client);
      let resolved: unknown;
      try {
        resolved = await testCase.invoke(fixture);
      } catch (error) {
        throw new Error(
          `failed case: ${testCase.name}; calls=${client.calls.map(({ text }) => text).join(" | ")}`,
          { cause: error },
        );
      }
      expect(resolved).toEqual(testCase.expected);
      expectProtocol(fixture, client, testCase.name);
      const call = operationCall(client);
      expect(call.values).toEqual(testCase.expectedValues);
      for (const cast of testCase.casts) expect(call.text).toContain(cast);
      expect(client.calls[2]?.values?.[2]).toBe(generatedUuid(1));
      expect(client.calls[2]?.values?.[0]).toBe(1);
      expect(client.calls[2]?.values?.[1]).toBeInstanceOf(Uint8Array);
      expect(call.values?.at(-3)).toBe(1);
      expect(call.values?.at(-2)).toBeInstanceOf(Uint8Array);
      expect(call.values?.at(-2)).not.toEqual(client.calls[2]?.values?.[1]);
    }
  });

  it("encodes organization-default disposable creation, later CAS, denial, and unarchive without widening the API", async () => {
    const disposableClient = new FakeClient({
      operation: (_text, values) =>
        oneRow(
          creationRow(values[0] as string, {
            effective_expires_at: new Date(createdAt.getTime() + 86_400_000),
            effective_ttl_seconds: 86_400,
            used_organization_default: true,
            lifecycle_policy_seeded: true,
          }),
        ),
    });
    const disposable = repositoryFixture(disposableClient);
    await disposable.repository.createDashboard({
      sessionToken: disposable.sessionToken,
      currentCsrfValue: disposable.currentCsrfValue,
      title: "Scratch",
      kind: "disposable",
      ttl: "organization_default",
    });
    expect(operationCall(disposableClient).values?.slice(1, 5)).toEqual([
      "Scratch",
      "disposable",
      null,
      true,
    ]);

    const laterClient = new FakeClient({
      operation: () => oneRow({ acknowledged: 1 }),
    });
    const later = repositoryFixture(laterClient);
    await later.repository.compareAndSwapDashboardHead({
      sessionToken: later.sessionToken,
      currentCsrfValue: later.currentCsrfValue,
      dashboardId: ids.dashboardA,
      expectedHeadVersionId: ids.versionA,
      newHeadVersionId: ids.versionB,
      expectedLifecycleRevision: 7,
    });
    expect(operationCall(laterClient).values?.slice(0, 4)).toEqual([
      ids.dashboardA,
      ids.versionA,
      ids.versionB,
      7,
    ]);

    const denialClient = new FakeClient({
      operation: () => oneRow({ acknowledged: 1 }),
    });
    const denial = repositoryFixture(denialClient);
    await expect(
      denial.repository.decideDashboardPromotion({
        sessionToken: denial.sessionToken,
        currentCsrfValue: denial.currentCsrfValue,
        promotionRequestId: ids.promotion,
        expectedLifecycleRevision: 7,
        decision: "denied",
      }),
    ).resolves.toEqual({ decision: "denied", lifecycleEventId: null });
    expect(operationCall(denialClient).values).toEqual([
      ids.promotion,
      7,
      "denied",
      null,
      generatedUuid(2),
      1,
      expect.any(Uint8Array),
      deploymentRevision,
    ]);

    const unarchiveClient = new FakeClient({
      operation: () => oneRow({ acknowledged: 1 }),
    });
    const unarchive = repositoryFixture(unarchiveClient);
    await unarchive.repository.setDashboardArchive({
      sessionToken: unarchive.sessionToken,
      currentCsrfValue: unarchive.currentCsrfValue,
      dashboardId: ids.dashboardA,
      archived: false,
      expectedLifecycleRevision: 8,
    });
    expect(operationCall(unarchiveClient).values?.slice(0, 3)).toEqual([
      ids.dashboardA,
      false,
      8,
    ]);
  });
});

describe("DashboardLifecycleRepository transaction normalization", () => {
  it.each([
    ["initialize", "P1001", OperationDeniedError],
    ["operation", "P1001", OperationDeniedError],
    ["initialize", "P1002", OperationConflictError],
    ["operation", "P1002", OperationConflictError],
    ["operation", "XX999", OperationInternalError],
  ] as const)(
    "maps %s SQLSTATE %s without leaking the database error",
    async (stage, code, ExpectedError) => {
      const raw = Object.assign(new Error("relation secret_table violated"), {
        code,
      });
      const client = new FakeClient({
        failure: { stage, error: raw },
        operation: () => oneRow(summaryRow()),
      });
      const fixture = repositoryFixture(client);
      const rejection = fixture.repository.getDashboardSummary({
        sessionToken: fixture.sessionToken,
        dashboardId: ids.dashboardA,
      });
      await expect(rejection).rejects.toBeInstanceOf(ExpectedError);
      await expect(rejection).rejects.not.toThrow(/secret_table|violated/);
      expect(client.calls.at(-1)?.text).toBe("ROLLBACK");
      expect(client.releases).toEqual([undefined]);
    },
  );

  it("rolls back initializer, operation, and row-validation failures before normal release", async () => {
    const cases = [
      new FakeClient({
        context: () => contextResult({ organization_id: "not-a-uuid" }),
        operation: () => oneRow(summaryRow()),
      }),
      new FakeClient({
        failure: { stage: "operation", error: new Error("x") },
      }),
      new FakeClient({ operation: () => oneRow({ acknowledged: 0 }) }),
    ];
    for (const client of cases) {
      const fixture = repositoryFixture(client);
      const promise =
        cases.indexOf(client) === 2
          ? fixture.repository.deleteDashboard({
              sessionToken: fixture.sessionToken,
              currentCsrfValue: fixture.currentCsrfValue,
              dashboardId: ids.dashboardA,
              expectedLifecycleRevision: 1,
            })
          : fixture.repository.getDashboardSummary({
              sessionToken: fixture.sessionToken,
              dashboardId: ids.dashboardA,
            });
      await expect(promise).rejects.toMatchObject({
        code: "internal_error",
        outcome: "not_committed",
      });
      expect(client.calls.at(-1)?.text).toBe("ROLLBACK");
      expect(client.releases).toEqual([undefined]);
    }
  });

  it("destroys on rollback failure and keeps the original normalized outcome", async () => {
    const client = new FakeClient({
      failure: { stage: "rollback", error: new Error("rollback failed") },
      operation: () => oneRow({ unexpected: true }),
    });
    const fixture = repositoryFixture(client);
    await expect(
      fixture.repository.getDashboardSummary({
        sessionToken: fixture.sessionToken,
        dashboardId: ids.dashboardA,
      }),
    ).rejects.toMatchObject({ outcome: "not_committed" });
    expect(client.calls.at(-1)?.text).toBe("ROLLBACK");
    expect(client.releases).toEqual([true]);
  });

  it("treats COMMIT failure as indeterminate, never rolls back, and destroys", async () => {
    const client = new FakeClient({
      failure: { stage: "commit", error: new Error("connection lost") },
      operation: () => oneRow(summaryRow()),
    });
    const fixture = repositoryFixture(client);
    await expect(
      fixture.repository.getDashboardSummary({
        sessionToken: fixture.sessionToken,
        dashboardId: ids.dashboardA,
      }),
    ).rejects.toMatchObject({
      code: "internal_error",
      outcome: "commit_indeterminate",
      retrySafe: false,
    });
    expect(client.calls.some(({ text }) => text === "ROLLBACK")).toBe(false);
    expect(client.releases).toEqual([true]);
  });

  it("falls back to destructive release after a hostile normal release without changing a committed result", async () => {
    const client = new FakeClient({
      operation: () => oneRow(summaryRow()),
      releaseFailure: true,
    });
    const fixture = repositoryFixture(client);
    await expect(
      fixture.repository.getDashboardSummary({
        sessionToken: fixture.sessionToken,
        dashboardId: ids.dashboardA,
      }),
    ).resolves.toMatchObject({ dashboardId: ids.dashboardA });
    expect(client.releases).toEqual([undefined, true]);
  });

  it("connects once per call and safely reuses the pool with distinct repository-owned request IDs", async () => {
    const first = new FakeClient({ operation: () => oneRow(summaryRow()) });
    const second = new FakeClient({ operation: () => oneRow(summaryRow()) });
    const clients = [first, second];
    const connect = vi.fn(async () => clients.shift()!);
    const fixture = repositoryFixture(first, generatedUuids(), connect);
    await fixture.repository.getDashboardSummary({
      sessionToken: fixture.sessionToken,
      dashboardId: ids.dashboardA,
    });
    await fixture.repository.getDashboardSummary({
      sessionToken: fixture.sessionToken,
      dashboardId: ids.dashboardA,
    });
    expect(connect).toHaveBeenCalledTimes(2);
    expect(first.calls[2]?.values?.[2]).toBe(generatedUuid(1));
    expect(second.calls[2]?.values?.[2]).toBe(generatedUuid(2));
    expect(first.releases).toEqual([undefined]);
    expect(second.releases).toEqual([undefined]);
  });

  it("reuses one repository beyond the UUID attempt limit without cumulative ID exhaustion", async () => {
    const callCount = 64;
    const requestId = generatedUuid(1);
    const clients = Array.from(
      { length: callCount },
      () => new FakeClient({ operation: () => oneRow(summaryRow()) }),
    );
    const pendingClients = [...clients];
    const connect = vi.fn(async () => pendingClients.shift()!);
    const fixture = repositoryFixture(
      clients[0]!,
      Array.from({ length: callCount }, () => requestId),
      connect,
    );

    for (let index = 0; index < callCount; index += 1) {
      await expect(
        fixture.repository.getDashboardSummary({
          sessionToken: fixture.sessionToken,
          dashboardId: ids.dashboardA,
        }),
      ).resolves.toMatchObject({ dashboardId: ids.dashboardA });
    }

    expect(connect).toHaveBeenCalledTimes(callCount);
    expect(pendingClients).toEqual([]);
    for (const client of clients) {
      expect(client.calls).toHaveLength(5);
      expect(client.calls[2]?.values?.[2]).toBe(requestId);
      expect(operationCall(client).text).toContain(
        "dasher_api.get_dashboard_summary(",
      );
      expect(operationCall(client).values).toEqual([ids.dashboardA]);
      expect(client.releases).toEqual([undefined]);
    }
  });
});

describe("DashboardLifecycleRepository strict synchronous snapshots", () => {
  it("rejects getters, proxies, inherited inputs, and unexpected keys before connect", async () => {
    const client = new FakeClient();
    const fixture = repositoryFixture(client);
    const getter = {
      sessionToken: fixture.sessionToken,
      get limit() {
        throw new Error("getter must not run");
      },
    };
    const proxy = new Proxy(
      { sessionToken: fixture.sessionToken, limit: 10 },
      {},
    );
    const inherited = Object.create({ organizationId: ids.organization }) as {
      sessionToken: string;
      limit: number;
    };
    inherited.sessionToken = fixture.sessionToken;
    inherited.limit = 10;
    const extra = {
      sessionToken: fixture.sessionToken,
      limit: 10,
      organizationId: ids.organization,
    };
    for (const candidate of [getter, proxy, inherited, extra]) {
      await expect(
        fixture.repository.listDashboards(candidate as never),
      ).rejects.toBeInstanceOf(OperationDeniedError);
    }
    expect(fixture.pool.connect).not.toHaveBeenCalled();
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["fraction", 1.5],
    ["oversized", 101],
    ["unsafe", Number.MAX_SAFE_INTEGER + 1],
  ])("rejects %s list limits before SQL", async (_name, limit) => {
    const fixture = repositoryFixture(new FakeClient());
    await expect(
      fixture.repository.listDashboards({
        sessionToken: fixture.sessionToken,
        limit,
      }),
    ).rejects.toBeInstanceOf(OperationDeniedError);
    expect(fixture.pool.connect).not.toHaveBeenCalled();
  });

  it("rejects malformed UUIDs, timestamps, digests, enums, and revisions before SQL", async () => {
    const invalidCalls: Array<
      (fixture: RepositoryFixture) => Promise<unknown>
    > = [
      ({ repository, sessionToken }) =>
        repository.getDashboardSummary({
          sessionToken,
          dashboardId: "NOT-CANONICAL",
        }),
      ({ repository, sessionToken, currentCsrfValue }) =>
        repository.createEvidenceRecord({
          sessionToken,
          currentCsrfValue,
          dashboardId: ids.dashboardA,
          versionId: ids.versionA,
          snapshotId: ids.snapshotA,
          evidenceKind: "typed_value",
          coordinates: "x",
          contentSha256: new Uint8Array(31),
          observedAt,
          retrievedAt,
        }),
      ({ repository, sessionToken, currentCsrfValue }) =>
        repository.createEvidenceRecord({
          sessionToken,
          currentCsrfValue,
          dashboardId: ids.dashboardA,
          versionId: ids.versionA,
          snapshotId: ids.snapshotA,
          evidenceKind: "source_record",
          coordinates: "x",
          contentSha256: digest("x"),
          observedAt: new Date(Number.NaN),
          retrievedAt,
        }),
      ({ repository, sessionToken, currentCsrfValue }) =>
        repository.requestDashboardPromotion({
          sessionToken,
          currentCsrfValue,
          dashboardId: ids.dashboardA,
          expectedLifecycleRevision: -1,
          rationaleSha256: digest("x"),
        }),
      ({ repository, sessionToken, currentCsrfValue }) =>
        repository.createDashboardVersion({
          sessionToken,
          currentCsrfValue,
          dashboardId: ids.dashboardA,
          parentVersionId: null,
          canonicalSpecBytes,
          canonicalSpecSha256,
          validationSha256: digest("validation"),
          plannerProvenanceSha256: digest("planner"),
          policyRevision: 0,
          registryRevision: 1,
          calculationGraphSha256: null,
          snapshotIds: [ids.snapshotA],
          evidenceIds: [],
        }),
    ];
    for (const invalidCall of invalidCalls) {
      const fixture = repositoryFixture(new FakeClient());
      await expect(invalidCall(fixture)).rejects.toBeInstanceOf(
        OperationDeniedError,
      );
      expect(fixture.pool.connect).not.toHaveBeenCalled();
    }
  });

  it("rejects a session secret in the CSRF slot before checkout", async () => {
    const fixture = repositoryFixture(new FakeClient());
    await expect(
      fixture.repository.deleteDashboard({
        sessionToken: fixture.sessionToken,
        currentCsrfValue: fixture.sessionToken,
        dashboardId: ids.dashboardA,
        expectedLifecycleRevision: 0,
      }),
    ).rejects.toBeInstanceOf(OperationDeniedError);
    expect(fixture.pool.connect).not.toHaveBeenCalled();
  });

  it("enforces the raw canonical-spec bound before copying and exact SHA-256 equality", async () => {
    const oversized = new Uint8Array(1_048_577);
    const mismatched = new Uint8Array(canonicalSpecSha256);
    mismatched[0] = (mismatched[0] ?? 0) ^ 0xff;
    for (const [spec, hash] of [
      [oversized, digestBytes(oversized)],
      [canonicalSpecBytes, mismatched],
    ] as const) {
      const fixture = repositoryFixture(new FakeClient());
      await expect(
        fixture.repository.createDashboardVersion({
          sessionToken: fixture.sessionToken,
          currentCsrfValue: fixture.currentCsrfValue,
          dashboardId: ids.dashboardA,
          parentVersionId: null,
          canonicalSpecBytes: spec,
          canonicalSpecSha256: hash,
          validationSha256: digest("validation"),
          plannerProvenanceSha256: digest("planner"),
          policyRevision: 1,
          registryRevision: 1,
          calculationGraphSha256: null,
          snapshotIds: [ids.snapshotA],
          evidenceIds: [],
        }),
      ).rejects.toBeInstanceOf(OperationDeniedError);
      expect(fixture.pool.connect).not.toHaveBeenCalled();
    }
  });

  it("requires a nonempty unique bounded snapshot set and permits zero evidence IDs", async () => {
    for (const snapshotIds of [[], [ids.snapshotA, ids.snapshotA]]) {
      const fixture = repositoryFixture(new FakeClient());
      await expect(
        fixture.repository.createDashboardVersion({
          sessionToken: fixture.sessionToken,
          currentCsrfValue: fixture.currentCsrfValue,
          dashboardId: ids.dashboardA,
          parentVersionId: null,
          canonicalSpecBytes,
          canonicalSpecSha256,
          validationSha256: digest("validation"),
          plannerProvenanceSha256: digest("planner"),
          policyRevision: 1,
          registryRevision: 1,
          calculationGraphSha256: null,
          snapshotIds,
          evidenceIds: [],
        }),
      ).rejects.toBeInstanceOf(OperationDeniedError);
      expect(fixture.pool.connect).not.toHaveBeenCalled();
    }

    const client = new FakeClient({
      operation: (_text, values) => oneRow({ version_id: values[1] }),
    });
    const fixture = repositoryFixture(client);
    await fixture.repository.createDashboardVersion({
      sessionToken: fixture.sessionToken,
      currentCsrfValue: fixture.currentCsrfValue,
      dashboardId: ids.dashboardA,
      parentVersionId: null,
      canonicalSpecBytes,
      canonicalSpecSha256,
      validationSha256: digest("validation"),
      plannerProvenanceSha256: digest("planner"),
      policyRevision: 1,
      registryRevision: 1,
      calculationGraphSha256: null,
      snapshotIds: [ids.snapshotA],
      evidenceIds: [],
    });
    expect(operationCall(client).values?.[12]).toEqual([]);
    expect(operationCall(client).values?.[13]).toEqual([]);
  });

  it("copies mutable bytes and Dates before the pending connect can observe caller mutation", async () => {
    let resolveConnect!: (client: PgCompatibleClient) => void;
    const connectPromise = new Promise<PgCompatibleClient>((resolve) => {
      resolveConnect = resolve;
    });
    const client = new FakeClient({
      operation: () => oneRow({ acknowledged: 1 }),
    });
    const connect = vi.fn(() => connectPromise);
    const fixture = repositoryFixture(client, generatedUuids(), connect);
    const content = digest("before");
    const observed = new Date(observedAt);
    const retrieved = new Date(retrievedAt);
    const input = {
      sessionToken: fixture.sessionToken,
      currentCsrfValue: fixture.currentCsrfValue,
      dashboardId: ids.dashboardA,
      versionId: ids.versionA,
      snapshotId: ids.snapshotA,
      evidenceKind: "typed_value" as const,
      coordinates: "metric=net_cash",
      contentSha256: content,
      observedAt: observed,
      retrievedAt: retrieved,
    };
    const expectedContent = new Uint8Array(content);
    const expectedObserved = observed.getTime();
    const expectedRetrieved = retrieved.getTime();
    const pending = fixture.repository.createEvidenceRecord(input);
    content.fill(0);
    observed.setTime(0);
    retrieved.setTime(1);
    Object.assign(input, { coordinates: "mutated" });
    resolveConnect(client);
    await pending;
    const values = operationCall(client).values!;
    expect(values[6]).toBe("metric=net_cash");
    expect(values[7]).toEqual(expectedContent);
    expect((values[8] as Date).getTime()).toBe(expectedObserved);
    expect((values[9] as Date).getTime()).toBe(expectedRetrieved);
  });

  it("validates deterministic UUID generation and skips duplicates without accepting them", async () => {
    const client = new FakeClient({
      operation: () => oneRow({ acknowledged: 1 }),
    });
    const fixture = repositoryFixture(client, [
      ids.dashboardA,
      generatedUuid(1),
      generatedUuid(1),
      generatedUuid(2),
    ]);
    await fixture.repository.deleteDashboard({
      sessionToken: fixture.sessionToken,
      currentCsrfValue: fixture.currentCsrfValue,
      dashboardId: ids.dashboardA,
      expectedLifecycleRevision: 1,
    });
    expect(client.calls[2]?.values?.[2]).toBe(generatedUuid(1));
    expect(operationCall(client).values?.[2]).toBe(generatedUuid(2));

    const invalidFixture = repositoryFixture(new FakeClient(), ["bad-uuid"]);
    await expect(
      invalidFixture.repository.listDashboards({
        sessionToken: invalidFixture.sessionToken,
        limit: 1,
      }),
    ).rejects.toBeInstanceOf(OperationInternalError);
    expect(invalidFixture.pool.connect).not.toHaveBeenCalled();
  });
});

describe("DashboardLifecycleRepository projection integrity and genericity", () => {
  it("decodes exact enums, nullability, integer strings, digests, and Dates with non-aliasing copies", async () => {
    const databaseSpec = new Uint8Array(canonicalSpecBytes);
    const databaseHash = new Uint8Array(canonicalSpecSha256);
    const databaseValidation = digest("database-validation");
    const databasePlanner = digest("database-planner");
    const databaseGraph = digest("database-graph");
    const databaseCreatedAt = new Date(createdAt);
    const client = new FakeClient({
      operation: () =>
        oneRow(
          versionRow({
            parent_version_id: ids.versionB,
            canonical_spec_bytes: databaseSpec,
            canonical_spec_sha256: databaseHash,
            validation_sha256: databaseValidation,
            planner_provenance_sha256: databasePlanner,
            calculation_graph_sha256: databaseGraph,
            policy_revision: "9",
            registry_revision: 10,
            created_at: databaseCreatedAt,
          }),
        ),
    });
    const fixture = repositoryFixture(client);
    const result = await fixture.repository.getDashboardVersion({
      sessionToken: fixture.sessionToken,
      dashboardId: ids.dashboardA,
      versionId: ids.versionA,
    });
    databaseSpec.fill(0);
    databaseHash.fill(0);
    databaseValidation.fill(0);
    databasePlanner.fill(0);
    databaseGraph.fill(0);
    databaseCreatedAt.setTime(0);
    expect(result).toMatchObject({
      dashboardId: ids.dashboardA,
      versionId: ids.versionA,
      parentVersionId: ids.versionB,
      validationState: "validated",
      policyRevision: 9,
      registryRevision: 10,
    });
    expect(result.canonicalSpecBytes).toEqual(canonicalSpecBytes);
    expect(result.canonicalSpecSha256).toEqual(canonicalSpecSha256);
    expect(result.createdAt.getTime()).toBe(createdAt.getTime());
    const callerBytes = result.canonicalSpecBytes;
    const callerDate = result.createdAt;
    callerBytes.fill(255);
    callerDate.setTime(1);
    expect(result.canonicalSpecBytes).toEqual(canonicalSpecBytes);
    expect(result.createdAt.getTime()).toBe(createdAt.getTime());
    expect(result.canonicalSpecBytes).not.toBe(result.canonicalSpecBytes);
    expect(result.createdAt).not.toBe(result.createdAt);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it.each([
    [
      "extra field",
      oneRow({ ...summaryRow(), organization_id: ids.organization }),
    ],
    ["invalid kind", oneRow(summaryRow({ current_kind: "scratch" }))],
    ["invalid lifecycle", oneRow(summaryRow({ lifecycle_state: "published" }))],
    [
      "invalid digest",
      oneRow(versionRow({ validation_sha256: new Uint8Array(31) })),
    ],
    [
      "hash mismatch",
      oneRow(versionRow({ canonical_spec_sha256: digest("wrong") })),
    ],
    ["invalid date", oneRow(versionRow({ created_at: new Date(Number.NaN) }))],
    [
      "unsafe revision",
      oneRow(summaryRow({ lifecycle_revision: "9007199254740992" })),
    ],
  ])("normalizes malformed projection row: %s", async (_name, operation) => {
    const isVersion = "canonical_spec_bytes" in (operation.rows[0] as object);
    const client = new FakeClient({ operation: () => operation });
    const fixture = repositoryFixture(client);
    const promise = isVersion
      ? fixture.repository.getDashboardVersion({
          sessionToken: fixture.sessionToken,
          dashboardId: ids.dashboardA,
          versionId: ids.versionA,
        })
      : fixture.repository.getDashboardSummary({
          sessionToken: fixture.sessionToken,
          dashboardId: ids.dashboardA,
        });
    await expect(promise).rejects.toMatchObject({
      code: "internal_error",
      outcome: "not_committed",
    });
    expect(client.calls.at(-1)?.text).toBe("ROLLBACK");
  });

  it("supports Sacramento river and heterogeneous cash-flow evidence through identical generic methods", async () => {
    const domains = [
      {
        coordinates: "station=11447650;metric=discharge;unit=ft3/s;grain=day",
        kind: "source_record" as const,
        rows: [
          evidenceRow({
            evidence_kind: "source_record",
            content_sha256: digest("sacramento-river"),
          }),
        ],
      },
      {
        coordinates:
          "account=operations;metrics=inflow|outflow|net;units=USD|count;grain=month;nullable=true",
        kind: "calculation_result" as const,
        rows: [
          evidenceRow({
            evidence_id: ids.evidenceA,
            evidence_kind: "typed_value",
          }),
          evidenceRow({
            evidence_id: ids.evidenceB,
            evidence_kind: "event_record",
            content_sha256: digest("cash-inflow"),
          }),
          evidenceRow({
            evidence_id: generatedUuid(90),
            evidence_kind: "calculation_result",
            content_sha256: digest("cash-outflow-net"),
          }),
        ],
      },
    ];
    for (const domain of domains) {
      const createClient = new FakeClient({
        operation: () => oneRow({ acknowledged: 1 }),
      });
      const createFixture = repositoryFixture(createClient);
      await createFixture.repository.createEvidenceRecord({
        sessionToken: createFixture.sessionToken,
        currentCsrfValue: createFixture.currentCsrfValue,
        dashboardId: ids.dashboardA,
        versionId: ids.versionA,
        snapshotId: ids.snapshotA,
        evidenceKind: domain.kind,
        coordinates: domain.coordinates,
        contentSha256: digest(domain.coordinates),
        observedAt,
        retrievedAt,
      });
      expect(operationCall(createClient).values?.[6]).toBe(domain.coordinates);

      const getClient = new FakeClient({
        operation: () => ({ rowCount: domain.rows.length, rows: domain.rows }),
      });
      const getFixture = repositoryFixture(getClient);
      const result = await getFixture.repository.getDashboardEvidence({
        sessionToken: getFixture.sessionToken,
        dashboardId: ids.dashboardA,
        versionId: ids.versionA,
      });
      expect(result).toHaveLength(domain.rows.length);
      expect(Object.isFrozen(result)).toBe(true);
      expect(result.every((row) => Object.isFrozen(row))).toBe(true);
    }
  });

  it("normalizes absent, stale, cross-dashboard, cross-organization, replay, and empty-evidence outcomes without selector leakage", async () => {
    const selectors = [
      "absent-dashboard",
      "duplicate-dashboard-uuid-other-organization",
      "dashboard-b-version-through-dashboard-a",
      "stale-non-head-version",
      "evidence-content-id-replay",
      "empty-evidence",
    ];
    const messages: string[] = [];
    for (const _selector of selectors) {
      const client = new FakeClient({
        failure: {
          stage: "operation",
          error: Object.assign(new Error(`private ${_selector}`), {
            code: "P1001",
          }),
        },
      });
      const fixture = repositoryFixture(client);
      try {
        await fixture.repository.getDashboardEvidence({
          sessionToken: fixture.sessionToken,
          dashboardId: ids.dashboardA,
          versionId: ids.versionB,
        });
      } catch (error) {
        expect(error).toBeInstanceOf(OperationDeniedError);
        messages.push((error as Error).message);
      }
      expect(operationCall(client).values).toEqual([
        ids.dashboardA,
        ids.versionB,
      ]);
    }
    expect(new Set(messages)).toEqual(new Set(["Operation denied"]));

    const staleClient = new FakeClient({
      failure: {
        stage: "operation",
        error: Object.assign(new Error("actual revision is 9"), {
          code: "P1002",
        }),
      },
    });
    const stale = repositoryFixture(staleClient);
    await expect(
      stale.repository.compareAndSwapDashboardHead({
        sessionToken: stale.sessionToken,
        currentCsrfValue: stale.currentCsrfValue,
        dashboardId: ids.dashboardA,
        expectedHeadVersionId: ids.versionA,
        newHeadVersionId: ids.versionB,
        expectedLifecycleRevision: 7,
      }),
    ).rejects.toEqual(new OperationConflictError());
  });

  it("treats impossible empty evidence/lineage rows and mismatched selector rows as internal database faults", async () => {
    for (const invoke of [
      (fixture: RepositoryFixture) =>
        fixture.repository.getDashboardEvidence({
          sessionToken: fixture.sessionToken,
          dashboardId: ids.dashboardA,
          versionId: ids.versionA,
        }),
      (fixture: RepositoryFixture) =>
        fixture.repository.getDashboardLineage({
          sessionToken: fixture.sessionToken,
          dashboardId: ids.dashboardA,
          versionId: ids.versionA,
        }),
    ]) {
      const fixture = repositoryFixture(new FakeClient());
      await expect(invoke(fixture)).rejects.toBeInstanceOf(
        OperationInternalError,
      );
    }

    const mismatchedClient = new FakeClient({
      operation: () =>
        oneRow(
          versionRow({
            dashboard_id: ids.dashboardB,
            version_id: ids.versionB,
          }),
        ),
    });
    const mismatched = repositoryFixture(mismatchedClient);
    await expect(
      mismatched.repository.getDashboardVersion({
        sessionToken: mismatched.sessionToken,
        dashboardId: ids.dashboardA,
        versionId: ids.versionA,
      }),
    ).rejects.toBeInstanceOf(OperationInternalError);
  });
});

describe("DashboardLifecycleRepository public boundary", () => {
  it("exports the intended app repository and no retention/operator/private capability", () => {
    expect(publicApi.DashboardLifecycleRepository).toBe(
      DashboardLifecycleRepository,
    );
    const publicNames = Object.keys(publicApi);
    expect(
      publicNames.some((name) =>
        /retention|operator|private|legal.?hold|purge/i.test(name),
      ),
    ).toBe(false);
  });

  it("contains exactly the 16 public methods and no generic selector or direct table operation seam", () => {
    expect(
      Object.getOwnPropertyNames(DashboardLifecycleRepository.prototype).sort(),
    ).toEqual(
      [
        "constructor",
        "listDashboards",
        "getDashboardSummary",
        "getDashboardHead",
        "getDashboardVersion",
        "getDashboardEvidence",
        "getDashboardLineage",
        "getDashboardAdminStatus",
        "createDashboard",
        "createEvidenceRecord",
        "createDashboardVersion",
        "compareAndSwapDashboardHead",
        "requestDashboardPromotion",
        "decideDashboardPromotion",
        "setDashboardArchive",
        "deleteDashboard",
        "restoreDashboardAsNew",
      ].sort(),
    );
    const source = readFileSync(
      new URL("./dashboard-lifecycle-repository.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/dasher_retention_api\.|dasher_private\./);
    expect(source).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|MERGE|TRUNCATE)\b/);
    expect(source).not.toMatch(/functionName|sqlName|operationName/);
    expect(source).not.toMatch(/organizationId.*(?:input|selector)/i);
    expect(source).not.toMatch(/context_csrf_allows|csrfDigest|csrfKeyVersion/);
  });

  it("keeps production types dashboard-general", () => {
    const typesSource = readFileSync(
      new URL("./dashboard-lifecycle-types.ts", import.meta.url),
      "utf8",
    );
    expect(typesSource).not.toMatch(/Sacramento|river|cash.?flow|USGS/i);
  });
});
