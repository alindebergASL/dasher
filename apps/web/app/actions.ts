"use server";

import { randomUUID } from "node:crypto";

import {
  DashboardRepositoryError,
  withDashboardRepository,
} from "@dasher/control-plane";
import {
  canonicalSpecBytes,
  type DashboardSpec,
} from "@dasher/dashboard-schema";
import {
  describePlan,
  PlanRejected,
  runTablePlanner,
  TablePlanSchema,
  type PlanningProvider,
  type TablePlan,
} from "@dasher/planner";

import { evidenceCitations, persistedClaims } from "./claims";
import { getPool, isPersistenceConfigured } from "./database";
import { planner, PlannerBudgetExceeded } from "./planner-config";
import {
  REFINEMENT_MAX_LENGTH,
  REQUEST_MAX_LENGTH,
  type PlanResult,
  type SourceRef,
} from "./planning";
import { provenanceOf } from "./provenance";
import { sampleBytes, SAMPLE_NAME } from "./samples";
import { readSessionCredential } from "./session";
import { readUpload, type ReadUpload } from "./upload";

const UPLOAD_SOURCE_KIND = "upload:csv";

/**
 * One action builds, rebuilds, and refines. The form carries either
 * `source=sample` or a `file`, a `request`, and optionally the previous `plan`
 * (JSON) with an `instruction` to change it. The browser re-sends the file on a
 * refinement, so the server holds nothing between requests.
 */
export async function buildDashboard(formData: FormData): Promise<PlanResult> {
  const request = String(formData.get("request") ?? "").trim();
  if (request === "") {
    return { ok: false, error: "Say what the dashboard should show." };
  }
  if (request.length > REQUEST_MAX_LENGTH) {
    return {
      ok: false,
      error: `Requests are limited to ${String(REQUEST_MAX_LENGTH)} characters. Yours is ${String(request.length)}.`,
    };
  }

  const read = await readSource(formData);
  if (!read.ok) return { ok: false, error: read.message };
  const { upload, source } = read;

  const refine = readRefinement(formData);
  if (refine !== undefined && !refine.ok) {
    return { ok: false, error: refine.message };
  }

  const provider = planner();
  const asOf = new Date().toISOString();
  let dashboard: DashboardSpec;
  let plan: TablePlan;
  let attempts: number;
  try {
    const run = await runTablePlanner({
      requestText: request,
      table: upload.table,
      provider,
      asOf,
      source: {
        name: upload.name,
        retrievedAt: asOf,
        sha256: upload.sha256,
        byteLength: upload.bytes.byteLength,
        rowCount: upload.table.rowCount,
      },
      ...(refine === undefined
        ? {}
        : {
            refine: {
              previousPlan: refine.plan,
              instruction: refine.instruction,
            },
          }),
    });
    dashboard = run.dashboard;
    plan = run.plan;
    attempts = run.attempts.length;
  } catch (error) {
    return { ok: false, error: buildFailureMessage(error) };
  }

  const result: PlanResult = {
    ok: true,
    dashboard,
    plan,
    mapping: describePlan(plan, upload.table),
    source,
    attempts,
    usesModel: provider.usesModel,
    ...(refine !== undefined && samePlan(refine.plan, plan)
      ? { refinement: "already-satisfied" as const }
      : {}),
  };

  if (refine !== undefined) return result;
  return persist(result, request, upload, source, provider);
}

/** Archive a saved dashboard so it leaves the list. Reversible in the database. */
export async function archiveDashboard(
  formData: FormData,
): Promise<{ ok: boolean; error?: string }> {
  const dashboardId = String(formData.get("dashboardId") ?? "");
  const revision = Number(formData.get("revision") ?? "");
  if (!isPersistenceConfigured() || !Number.isInteger(revision)) {
    return { ok: false, error: "Nothing to archive." };
  }
  const credential = await readSessionCredential();
  if (credential === undefined) {
    return { ok: false, error: "Sign in to archive a dashboard." };
  }
  try {
    await withDashboardRepository(getPool(), credential, (repository) =>
      repository.archive(dashboardId, revision),
    );
    return { ok: true };
  } catch {
    return {
      ok: false,
      error: "That dashboard could not be archived. Reload and try again.",
    };
  }
}

async function readSource(
  formData: FormData,
): Promise<
  | { ok: true; upload: ReadUpload; source: SourceRef }
  | { ok: false; message: string }
> {
  if (formData.get("source") === "sample") {
    const read = readUpload(SAMPLE_NAME, sampleBytes());
    return read.ok
      ? { ok: true, upload: read.upload, source: { kind: "sample" } }
      : { ok: false, message: read.message };
  }
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return {
      ok: false,
      message: "Choose a CSV file to build a dashboard from.",
    };
  }
  const read = readUpload(
    file.name.trim() === "" ? "upload.csv" : file.name,
    new Uint8Array(await file.arrayBuffer()),
  );
  return read.ok
    ? { ok: true, upload: read.upload, source: { kind: "upload" } }
    : { ok: false, message: read.message };
}

function readRefinement(
  formData: FormData,
):
  | { ok: true; plan: TablePlan; instruction: string }
  | { ok: false; message: string }
  | undefined {
  const rawPlan = formData.get("plan");
  const instruction = String(formData.get("instruction") ?? "").trim();
  if (rawPlan === null && instruction === "") return undefined;
  if (instruction === "") {
    return { ok: false, message: "Say what you want to change." };
  }
  if (instruction.length > REFINEMENT_MAX_LENGTH) {
    return {
      ok: false,
      message: `Changes are limited to ${String(REFINEMENT_MAX_LENGTH)} characters. Yours is ${String(instruction.length)}.`,
    };
  }
  let plan: TablePlan;
  try {
    plan = TablePlanSchema.parse(JSON.parse(String(rawPlan)));
  } catch {
    return {
      ok: false,
      message: "The dashboard to change was not recognised. Build it again.",
    };
  }
  return { ok: true, plan, instruction };
}

function samePlan(one: TablePlan, two: TablePlan): boolean {
  return JSON.stringify(one) === JSON.stringify(two);
}

function buildFailureMessage(error: unknown): string {
  if (error instanceof PlannerBudgetExceeded) {
    return "Dasher has used today's planning budget. Try again tomorrow, or switch to the built-in planner.";
  }
  if (error instanceof PlanRejected) {
    const first = error.findings[0];
    return `Dasher could not build a dashboard it could stand behind for that request.${first === undefined ? "" : ` ${first.message}`}`;
  }
  return "Something went wrong building that dashboard. Try rewording the request.";
}

async function persist(
  result: PlanResult,
  request: string,
  upload: ReadUpload,
  source: SourceRef,
  provider: PlanningProvider,
): Promise<PlanResult> {
  if (!isPersistenceConfigured() || result.dashboard === undefined) {
    return result;
  }
  const credential = await readSessionCredential();
  if (credential === undefined) return result;
  const dashboard = result.dashboard;
  const provenance = provenanceOf(provider);
  try {
    const dashboardId = await withDashboardRepository(
      getPool(),
      credential,
      async (repository) => {
        const requestId = randomUUID();
        const deploymentRevision =
          process.env["DASHER_DEPLOYMENT_REVISION"] ?? "dev";
        const sourceSnapshotId =
          source.kind === "upload"
            ? await repository.recordSourceSnapshot({
                sourceKind: UPLOAD_SOURCE_KIND,
                sourceRef: upload.name.slice(0, 512),
                bytes: upload.bytes,
                observedAt: new Date(dashboard.generatedAt),
                requestId,
                deploymentRevision,
              })
            : undefined;
        const recordIdBySpecEvidenceId = new Map<string, string>();
        if (sourceSnapshotId !== undefined) {
          for (const citation of evidenceCitations(dashboard)) {
            recordIdBySpecEvidenceId.set(
              citation.specEvidenceId,
              await repository.recordEvidence({
                ...citation.record,
                snapshotId: sourceSnapshotId,
                requestId,
                deploymentRevision,
              }),
            );
          }
        }
        const saved = await repository.save({
          title: dashboard.title,
          requestText: request,
          provider: provenance.provider,
          model: provenance.model,
          canonicalSpecBytes: canonicalSpecBytes(dashboard),
          claims: persistedClaims(dashboard, recordIdBySpecEvidenceId),
          ...(sourceSnapshotId === undefined ? {} : { sourceSnapshotId }),
          requestId,
          deploymentRevision,
        });
        return saved.dashboardId;
      },
    );
    return { ...result, dashboardId };
  } catch (error) {
    if (
      error instanceof DashboardRepositoryError &&
      error.code === "not_authenticated"
    ) {
      return {
        ...result,
        error:
          "This dashboard was built, but your session has ended, so it was not saved. Sign in again to keep what you build.",
      };
    }
    return {
      ...result,
      error: "This dashboard was built but could not be saved.",
    };
  }
}
