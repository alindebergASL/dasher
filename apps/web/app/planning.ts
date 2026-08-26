import type { DashboardSpec } from "@dasher/dashboard-schema";
import type { DashboardPlan } from "@dasher/planner";

/**
 * Shared planning contract. This module is deliberately separate from
 * `actions.ts`: a `"use server"` module may only export async functions, so
 * constants and types live here.
 */

export const REQUEST_MAX_LENGTH = 500;

/**
 * Shorter than a request on purpose. A refinement is one change to a dashboard
 * already on screen ("drop the map", "just the American river"), not a fresh
 * brief, and a box sized for an essay invites one.
 */
export const REFINEMENT_MAX_LENGTH = 200;

export const DEFAULT_REQUEST =
  "Create a live dashboard monitoring river gauges near Sacramento";

export interface PlanResult {
  ok: boolean;
  dashboard?: DashboardSpec;
  /**
   * The accepted plan, returned so the client can hand it back with a
   * refinement. It is composition only — no readings, no evidence — and it is
   * re-parsed against `DashboardPlanSchema` when it comes back, so the round
   * trip through the browser adds no trust.
   */
  plan?: DashboardPlan;
  /** Present when `ok` is false. Written for the person who typed the request. */
  error?: string;
  /** How many plan attempts were needed, including revisions. */
  attempts?: number;
  /**
   * Present only when a refinement produced the same plan it started from, and
   * says why, because the two reasons need opposite messages:
   *
   * - `not-understood` — nothing in the instruction was recognised.
   * - `already-satisfied` — it was understood and the dashboard already
   *   matched it, so telling the reader it failed would be false.
   */
  refinement?: "not-understood" | "already-satisfied";
  /**
   * Why this dashboard has no refinement path, when it has none.
   *
   * Absence of a plan is what the workspace can observe, but it is not why:
   *
   * - `official-snapshot` — a builder produced the dashboard directly, so
   *   there is no plan to edit.
   * - `combined-sources` — there are TWO plans behind the dashboard and no
   *   rule yet for which one an instruction addresses.
   * - `uploaded-file` — the figures came from a file the reader supplied, and
   *   a refinement would have to read it again.
   *
   * They read as the same missing field and need different sentences. The
   * workspace showed the official-snapshot wording for both until a combined
   * dashboard existed to prove it wrong: a river-and-air dashboard is not an
   * official snapshot, and telling a reader it is describes a different
   * product than the one they are looking at.
   *
   * `uploaded-file` was added for the same reason, and by making the same
   * mistake first — the upload path shipped its dashboards as
   * `official-snapshot` in review, which told readers that the CSV on their own
   * laptop was an official source. A third value costs one sentence; the
   * alternative is a product that describes itself wrongly to whoever built it.
   */
  noRefinement?: "official-snapshot" | "combined-sources" | "uploaded-file";
  /**
   * Present when the dashboard was persisted and can be reopened at
   * `/d/{id}`. Absent when the app runs without a database or the browser has
   * no session — both ordinary states, not failures.
   */
  dashboardId?: string;
}
