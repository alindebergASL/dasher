import type { DashboardSpec } from "@dasher/dashboard-schema";
import type { TablePlan } from "@dasher/planner";

/**
 * Shared between the server actions and the client workspace. A `"use server"`
 * module may only export async functions, so the constants and types live here.
 */

export const REQUEST_MAX_LENGTH = 500;
export const REFINEMENT_MAX_LENGTH = 200;
export const UPLOAD_MAX_BYTES = 4 * 1024 * 1024;

export const DEFAULT_REQUEST =
  "Where is the money going, and what changed last month?";

/** Which bytes a dashboard was built from, so a refinement can rebuild it. */
export type SourceRef = { kind: "sample" } | { kind: "upload" };

/** A source-neutral read of the canonical dataset, shown before the result. */
export interface DatasetInterpretation {
  readonly primaryMeasure: string;
  readonly period: string;
  readonly otherMeasures: readonly string[];
  readonly identifiers: readonly string[];
}

export interface PlanResult {
  ok: boolean;
  dashboard?: DashboardSpec;
  /** The accepted plan, handed back with a refinement. Re-parsed on return. */
  plan?: TablePlan;
  /** One sentence on how the file was read: which column played which part. */
  mapping?: string;
  /** The trusted semantic roles a reader can inspect and correct. */
  interpretation?: DatasetInterpretation;
  source?: SourceRef;
  /** Present when `ok` is false. Written for the person who asked. */
  error?: string;
  /** Plan attempts used, including revisions after a rejected plan. */
  attempts?: number;
  /** Present when the dashboard was saved. */
  dashboardId?: string;
  /** Present when a refinement changed nothing. */
  refinement?: "not-understood" | "already-satisfied";
  /** Whether a model chose the composition. */
  usesModel?: boolean;
}
