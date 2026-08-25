import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import fixture from "../../../fixtures/usgs/sacramento-instantaneous-values.json";
import { compilePlan, type DashboardPlan } from "@dasher/planner";
import { parseUsgsInstantaneousValues } from "@dasher/river-domain";

import type { PlanResult } from "../app/planning";

import { RequestWorkspace } from "./request-workspace";

/**
 * What the workspace does with a result that succeeded and failed at once.
 *
 * `actions.ts` separates planning from persistence so a save failure keeps the
 * dashboard and reports the failure: `ok: true`, a dashboard, and an error. The
 * component then took the success branch and cleared the error unconditionally,
 * so the message written to make persistence failure loud was discarded before
 * anything rendered.
 *
 * No end-to-end test caught it and none can cheaply: the browser suite runs
 * against a database that is up, so the save never fails. The failure only
 * exists in the seam between what the action returns and what the component
 * keeps, which is exactly where a component test belongs.
 */

const { planDashboard, refineDashboard, uploadLedgerDashboard } = vi.hoisted(
  () => ({
    planDashboard: vi.fn(),
    refineDashboard: vi.fn(),
    // Named even though nothing here calls it. The workspace renders the upload
    // panel, which imports it, and a mock missing an export the module graph
    // reaches is a failure that surfaces somewhere unrelated.
    uploadLedgerDashboard: vi.fn(),
  }),
);

vi.mock("@/app/actions", () => ({
  planDashboard,
  refineDashboard,
  uploadLedgerDashboard,
}));

const gauges = parseUsgsInstantaneousValues(fixture);

const plan: DashboardPlan = {
  planVersion: "plan-v1",
  title: "Sacramento River Conditions",
  audience: "Residents",
  framing: "Current conditions across the monitored gauges.",
  siteIds: [gauges[0]!.siteId],
  pages: [
    {
      id: "overview",
      title: "Overview",
      description: "Current conditions.",
      sections: ["conditions-summary", "gauge-table"],
    },
  ],
};

const dashboard = compilePlan(plan, gauges, {
  asOf: "2026-07-29T12:02:00.000Z",
  planner: { id: "fake", usesModel: false },
});

const initialPlan: DashboardPlan = {
  ...plan,
  title: "Initial dashboard that must be replaced",
  framing: "This dashboard exists only before the submitted request resolves.",
};

const initialDashboard = compilePlan(initialPlan, gauges, {
  asOf: "2026-07-29T12:02:00.000Z",
  planner: { id: "fake", usesModel: false },
});

const SAVE_FAILED = "This dashboard was built but could not be saved.";

// Statically imported: `vi.mock` is hoisted above imports, so the dynamic
// import this used was unnecessary — and the generated-code gate forbids one in
// first-party source, correctly, since a dynamic specifier is invisible to it.
function renderWorkspace() {
  return render(
    <RequestWorkspace
      initialDashboard={initialDashboard}
      initialPlan={initialPlan}
      initialRequest="Show me river conditions near Sacramento"
    />,
  );
}

beforeEach(() => {
  planDashboard.mockReset();
  refineDashboard.mockReset();
});

describe("the planning disclosure", () => {
  it("describes deterministic generation without claiming every dashboard used the sensor planner", () => {
    renderWorkspace();

    expect(screen.getByText(/Deterministic generation\./u)).toBeVisible();
    expect(screen.queryByText(/Fixture mode\./u)).toBeNull();
  });

  it("accepts a deterministic dashboard with no plan and hides refinement", async () => {
    planDashboard.mockResolvedValue({
      ok: true,
      dashboard,
      attempts: 1,
      dashboardId: "11111111-1111-4111-8111-111111111111",
    } satisfies PlanResult);

    renderWorkspace();
    screen.getByRole("button", { name: "Build dashboard" }).click();

    await waitFor(() => {
      expect(
        screen.getAllByText(plan.title, { exact: false }).length,
      ).toBeGreaterThan(0);
    });
    expect(screen.queryByLabelText("Change this dashboard")).toBeNull();
    expect(
      screen.getByText(/official snapshot has no refinement path yet/u),
    ).toBeVisible();
    expect(
      screen.getByRole("link", { name: "Open this dashboard by link" }),
    ).toHaveAttribute("href", "/d/11111111-1111-4111-8111-111111111111");
  });
});

describe("a dashboard that was built but not saved", () => {
  it("shows the save failure instead of discarding it", async () => {
    const result: PlanResult = {
      ok: true,
      dashboard,
      plan,
      attempts: 1,
      error: SAVE_FAILED,
    };
    planDashboard.mockResolvedValue(result);

    renderWorkspace();
    screen.getByRole("button", { name: "Build dashboard" }).click();

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(SAVE_FAILED);
    });
  });

  it("still renders the dashboard, because it was really built", async () => {
    // The other half. Reporting the failure by throwing the dashboard away
    // would be its own wrong answer: the reader asked for a dashboard, got
    // one, and only its durability failed.
    planDashboard.mockResolvedValue({
      ok: true,
      dashboard,
      plan,
      attempts: 1,
      error: SAVE_FAILED,
    } satisfies PlanResult);

    renderWorkspace();
    screen.getByRole("button", { name: "Build dashboard" }).click();

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(SAVE_FAILED);
    });
    expect(
      screen.getAllByText(plan.title, { exact: false }).length,
    ).toBeGreaterThan(0);
    expect(
      screen.queryAllByText(initialPlan.title, { exact: false }),
    ).toHaveLength(0);
  });

  it("clears a previous error when a later result carries none", async () => {
    // The clearing this replaced was unconditional, and it did have a job:
    // a stale error must not outlive the request that produced it.
    planDashboard.mockResolvedValueOnce({
      ok: true,
      dashboard,
      plan,
      attempts: 1,
      error: SAVE_FAILED,
    } satisfies PlanResult);

    renderWorkspace();
    screen.getByRole("button", { name: "Build dashboard" }).click();
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(SAVE_FAILED);
    });

    planDashboard.mockResolvedValueOnce({
      ok: true,
      dashboard,
      plan,
      attempts: 1,
      dashboardId: "11111111-1111-4111-8111-111111111111",
    } satisfies PlanResult);
    // The button reads "Building…" while the transition is pending, so waiting
    // for its label is waiting for the first request to finish.
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Build dashboard" }),
      ).toBeEnabled();
    });
    screen.getByRole("button", { name: "Build dashboard" }).click();

    await waitFor(() => {
      expect(screen.queryByRole("alert")).toBeNull();
    });
    expect(
      screen.getByRole("link", { name: "Open this dashboard by link" }),
    ).toHaveAttribute("href", "/d/11111111-1111-4111-8111-111111111111");
  });
});
