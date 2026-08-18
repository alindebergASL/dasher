import type { DashboardSpec } from "@dasher/dashboard-schema";
import type { DashboardPlan } from "@dasher/planner";

/**
 * Shared planning contract. This module is deliberately separate from
 * `actions.ts`: a `"use server"` module may only export async functions, so
 * constants and types live here.
 */

/**
 * Fixture mode. The observations are the committed USGS-format fixture and
 * `asOf` is pinned to its creation time, so a request is reproducible and no
 * live source is contacted.
 */
export const PLANNED_DASHBOARD_AS_OF = "2026-07-29T12:02:00.000Z";

export const REQUEST_MAX_LENGTH = 500;

/**
 * Shorter than a request on purpose. A refinement is one change to a dashboard
 * already on screen ("drop the map", "just the American river"), not a fresh
 * brief, and a box sized for an essay invites one.
 */
export const REFINEMENT_MAX_LENGTH = 200;

/**
 * Demo threshold, standing in for a user-configured alert. It is applied by
 * trusted code, never offered to the planner.
 */
export const DEMO_THRESHOLDS = [
  {
    id: "freeport-demo-threshold",
    siteId: "11447650",
    label: "Freeport watch level",
    stageAbove: 14.5,
  },
] as const;

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
   * Present when the dashboard was persisted and can be reopened at
   * `/d/{id}`. Absent when the app runs without a database or the browser has
   * no session — both ordinary states, not failures.
   */
  dashboardId?: string;
}
