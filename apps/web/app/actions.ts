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
  runTablePlanner,
  TablePlanSchema,
  type PlanningProvider,
  type TablePlan,
} from "@dasher/planner";

import { headers } from "next/headers";

import { evidenceCitations, persistedClaims } from "./claims";
import { getPool, isPersistenceConfigured } from "./database";
import { buildFailureMessage, planner } from "./planner-config";
import {
  REFINEMENT_MAX_LENGTH,
  REQUEST_MAX_LENGTH,
  type DatasetInterpretation,
  type PlanResult,
  type SourceRef,
} from "./planning";
import { provenanceOf } from "./provenance";
import { sampleBytes, SAMPLE_NAME } from "./samples";
import { readSessionCredential } from "./session";
import { clientKey, SlidingWindowThrottle } from "./sign-in/throttle";
import { readUpload, type ReadUpload } from "./upload";

const UPLOAD_SOURCE_KIND = "upload:csv";

/**
 * Builds are reachable without a session, so one caller cannot be allowed to
 * spend the instance's CPU or the planning budget at will. Per process, which
 * is what a single-instance deployment has.
 */
const BUILD_THROTTLE_KEY = Symbol.for("dasher.web.buildThrottle");
interface ThrottleCarrier {
  [BUILD_THROTTLE_KEY]?: SlidingWindowThrottle;
}
function buildThrottle(): SlidingWindowThrottle {
  const carrier = globalThis as ThrottleCarrier;
  carrier[BUILD_THROTTLE_KEY] ??= new SlidingWindowThrottle(
    120,
    60 * 60 * 1_000,
  );
  return carrier[BUILD_THROTTLE_KEY];
}

/**
 * A stored `source_ref` must be trimmed, printable and non-empty; the column's
 * CHECK rejects anything else and would abort the whole save, losing a
 * dashboard the reader watched being built.
 */
function safeSourceRef(name: string): string {
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .trim()
    .slice(0, 512)
    .trim();
  return cleaned === "" ? "upload.csv" : cleaned;
}

function datasetInterpretation(
  plan: TablePlan,
  upload: ReadUpload,
): DatasetInterpretation {
  return {
    primaryMeasure: plan.roles.amount,
    period: plan.roles.period ?? "No period detected",
    otherMeasures: upload.table.columns
      .filter(
        (column) =>
          column.semanticKind === "measure" &&
          column.name !== plan.roles.amount,
      )
      .map((column) => column.name),
    identifiers: upload.table.columns
      .filter((column) =>
        ["identifier", "code", "ordinal"].includes(column.semanticKind),
      )
      .map((column) => column.name),
  };
}

/**
 * One action builds, rebuilds, and refines. The form carries either
 * `source=sample` or a `file`, a `request`, and optionally the previous `plan`
 * (JSON) with an `instruction` to change it. The browser re-sends the file on a
 * refinement, so the server holds nothing between requests.
 */
export async function buildDashboard(formData: FormData): Promise<PlanResult> {
  if (!buildThrottle().allow(clientKey(await headers()))) {
    return {
      ok: false,
      error:
        "Too many dashboards built from this connection in the past hour. Try again later.",
    };
  }

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

  const asOf = new Date().toISOString();
  let dashboard: DashboardSpec;
  let plan: TablePlan;
  let attempts: number;
  let provider: PlanningProvider;
  try {
    // Inside the try: a misconfigured DASHER_PLANNER throws here, and the
    // landing page renders this action's result, so an escape becomes a 500.
    provider = planner();
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
    interpretation: datasetInterpretation(plan, upload),
    source,
    attempts,
    usesModel: provider.usesModel,
    ...(refine !== undefined && samePlan(refine.plan, plan)
      ? { refinement: "already-satisfied" as const }
      : {}),
  };

  // The landing page builds the sample nobody asked for; it must not write to
  // whichever organization happens to be signed in on that request.
  if (refine !== undefined || formData.get("persist") === "no") return result;
  return persist(result, request, upload, source, provider);
}

/**
 * Change a dashboard that was already saved, from its own page.
 *
 * A saved dashboard used to be read-only, because the page renders the bytes
 * that were sealed rather than recompiling, and nothing kept the plan those
 * bytes came from. Both halves of the input are now durable — the file as an
 * immutable snapshot, the plan beside the version — so a refinement here is the
 * same operation the composer performs, ending in a successor version rather
 * than a new dashboard.
 *
 * The revision read alongside the plan is passed back to the write. Somebody
 * else refining the same dashboard in the meantime moves it, and the seam
 * refuses rather than quietly discarding their version.
 */
export async function refineSavedDashboard(
  formData: FormData,
): Promise<{ ok: boolean; error?: string; versionId?: string }> {
  const dashboardId = String(formData.get("dashboardId") ?? "");
  const instruction = String(formData.get("instruction") ?? "").trim();
  if (instruction === "") {
    return { ok: false, error: "Say what you want to change." };
  }
  if (instruction.length > REFINEMENT_MAX_LENGTH) {
    return {
      ok: false,
      error: `Changes are limited to ${String(REFINEMENT_MAX_LENGTH)} characters. Yours is ${String(instruction.length)}.`,
    };
  }
  if (!isPersistenceConfigured()) {
    return { ok: false, error: "Saved dashboards are not configured." };
  }
  const credential = await readSessionCredential();
  if (credential === undefined) {
    return { ok: false, error: "Sign in to change a saved dashboard." };
  }
  if (!buildThrottle().allow(clientKey(await headers()))) {
    return {
      ok: false,
      error:
        "Too many dashboards built from this connection in the past hour. Try again later.",
    };
  }

  try {
    return await withDashboardRepository(
      getPool(),
      credential,
      async (repository) => {
        const loaded = await repository.loadById(dashboardId);
        if (loaded === undefined) {
          return { ok: false, error: "That dashboard could not be found." };
        }
        if (loaded.plan === undefined) {
          // Every version saved before plans were stored. The dashboard opens
          // and its figures stand; only changing it is unavailable, and saying
          // which is better than a failure that reads like a fault.
          return {
            ok: false,
            error:
              "This dashboard was saved before Dasher kept the reading behind it, so it cannot be changed here. Build it again from the file to make it editable.",
          };
        }
        if (loaded.sourceSnapshotId === undefined) {
          return {
            ok: false,
            error:
              "This dashboard was not built from an uploaded file, so there is nothing to recompute from.",
          };
        }
        const snapshot = await repository.loadSourceSnapshot(
          loaded.sourceSnapshotId,
        );
        if (snapshot === undefined) {
          return {
            ok: false,
            error: "The file behind this dashboard is no longer available.",
          };
        }

        let previousPlan: TablePlan;
        try {
          previousPlan = TablePlanSchema.parse(loaded.plan.plan);
        } catch {
          // A plan stored by a version of this code that shaped them
          // differently. The dashboard still renders; it just cannot be edited
          // by this build, which is a true statement rather than a crash.
          return {
            ok: false,
            error:
              "The reading stored with this dashboard is not one this version understands. Build it again from the file.",
          };
        }

        const read = readUpload(
          snapshot.sourceRef,
          new Uint8Array(snapshot.bytes),
        );
        if (!read.ok) return { ok: false, error: read.message };

        const asOf = new Date().toISOString();
        const provider = planner();
        const run = await runTablePlanner({
          requestText: previousPlan.title,
          table: read.upload.table,
          provider,
          asOf,
          source: {
            name: snapshot.sourceRef,
            // The file's own retrieval time, not this request's: the bytes were
            // fetched once and recomputing them does not re-fetch them.
            retrievedAt: snapshot.retrievedAt,
            sha256: read.upload.sha256,
            byteLength: read.upload.bytes.byteLength,
            rowCount: read.upload.table.rowCount,
          },
          refine: { previousPlan, instruction },
        });

        const provenance = provenanceOf(provider);
        const requestId = randomUUID();
        const deploymentRevision =
          process.env["DASHER_DEPLOYMENT_REVISION"] ?? "dev";
        const saved = await repository.revise({
          dashboardId,
          expectedRevision: loaded.lifecycleRevision,
          title: run.dashboard.title,
          requestText: instruction,
          provider: provenance.provider,
          model: provenance.model,
          canonicalSpecBytes: canonicalSpecBytes(run.dashboard),
          claims: persistedClaims(run.dashboard, new Map()),
          sourceSnapshotId: loaded.sourceSnapshotId,
          plan: { version: run.plan.planVersion, plan: run.plan },
          requestId,
          deploymentRevision,
        });
        return { ok: true, versionId: saved.versionId };
      },
    );
  } catch (error) {
    if (
      error instanceof DashboardRepositoryError &&
      error.code === "conflict"
    ) {
      return {
        ok: false,
        error:
          "This dashboard changed while you were editing it. Reload and try again.",
      };
    }
    if (
      error instanceof DashboardRepositoryError &&
      error.code === "not_authenticated"
    ) {
      return { ok: false, error: "Sign in to change a saved dashboard." };
    }
    return { ok: false, error: buildFailureMessage(error) };
  }
}

/** Archive a saved dashboard so it leaves the list. Reversible in the database. */
export async function archiveDashboard(
  formData: FormData,
): Promise<{ ok: boolean; error?: string }> {
  const dashboardId = String(formData.get("dashboardId") ?? "");
  const rawRevision = formData.get("revision");
  // Number("") is 0 and Number.isInteger(0) is true, so an absent field would
  // pass a bare Number() check and reach the database as a real revision.
  const revision =
    typeof rawRevision === "string" && rawRevision.trim() !== ""
      ? Number(rawRevision)
      : Number.NaN;
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
                sourceRef: safeSourceRef(upload.name),
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
          // Kept so this dashboard can be changed later and not only reopened.
          // The stored bytes say what the figures were; the plan says how they
          // were read, which is the thing a refinement edits.
          ...(result.plan === undefined
            ? {}
            : {
                plan: { version: result.plan.planVersion, plan: result.plan },
              }),
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
