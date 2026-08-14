import type { DashboardSpec } from "@dasher/dashboard-schema";

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
  /** Present when `ok` is false. Written for the person who typed the request. */
  error?: string;
  /** How many plan attempts were needed, including revisions. */
  attempts?: number;
}
