// @vitest-environment node
import type { PlanningProvider } from "@dasher/planner";
import { describe, expect, it, vi } from "vitest";

const {
  readSessionCredential,
  isPersistenceConfigured,
  plannerMock,
  modelPlan,
} = vi.hoisted(() => {
  const modelPlan = vi.fn(async () => ({
    planVersion: "table-plan-v1",
    title: "Synthetic overview",
    audience: "Operations",
    framing: "A summary of the dataset.",
    roles: { amount: "Amount" },
    grain: "month",
    filters: [],
    pages: [
      {
        id: "overview",
        title: "Overview",
        description: "A dataset summary.",
        sections: ["summary"],
      },
    ],
  }));
  return {
    readSessionCredential: vi.fn(),
    isPersistenceConfigured: vi.fn(() => true),
    modelPlan,
    plannerMock: vi.fn<() => PlanningProvider>(() => ({
      id: "stage-1-test-model",
      usesModel: true,
      plan: modelPlan,
    })),
  };
});

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.77" }),
}));
vi.mock("./session", () => ({ readSessionCredential }));
vi.mock("./database", () => ({
  isPersistenceConfigured,
  getPool: () => {
    throw new Error("persistence must not be reached");
  },
}));
vi.mock("./planner-config", async () => {
  const actual =
    await vi.importActual<typeof import("./planner-config")>(
      "./planner-config",
    );
  return { ...actual, planner: plannerMock };
});
vi.mock("server-only", () => ({}));

import { FakePlanningProvider } from "@dasher/planner";

import { buildDashboard } from "./actions";

const GENERIC_REFUSAL =
  "This dataset can't be used because it may contain credentials. Remove sensitive fields and try again. The current dashboard is unchanged.";

describe("stage 1 credential refusal ordering", () => {
  it("refuses the upload before planner configuration, model calls, or persistence", async () => {
    const form = new FormData();
    form.set("request", "Show an overview");
    form.set(
      "file",
      new File(
        ["Amount,Access Token\n10,SYNTHETIC-TEST-PLACEHOLDER\n"],
        "synthetic-dataset.csv",
        { type: "text/csv" },
      ),
    );

    const result = await buildDashboard(form);

    expect.soft(result).toEqual({ ok: false, error: GENERIC_REFUSAL });
    expect.soft(plannerMock).not.toHaveBeenCalled();
    expect.soft(modelPlan).not.toHaveBeenCalled();
    expect.soft(readSessionCredential).not.toHaveBeenCalled();
  });

  it("returns a calm action result when no safe measure exists", async () => {
    plannerMock.mockReturnValueOnce(new FakePlanningProvider());
    const form = new FormData();
    form.set("request", "Show an overview");
    form.set("persist", "no");
    form.set(
      "file",
      new File(
        [
          "Chassis ID,ZIP Code,Priority Rank,Region\n101,10001,1,North\n102,10002,2,South\n",
        ],
        "synthetic-identifiers.csv",
        { type: "text/csv" },
      ),
    );

    const result = await buildDashboard(form);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/safe(?:ly)?|measure/iu);
    expect(result.dashboard).toBeUndefined();
    expect(modelPlan).not.toHaveBeenCalled();
    expect(readSessionCredential).not.toHaveBeenCalled();
  });
});
