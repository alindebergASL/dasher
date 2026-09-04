// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FakePlanningProvider } from "@dasher/planner";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { readSessionCredential, isPersistenceConfigured, plannerMock } =
  vi.hoisted(() => ({
    readSessionCredential: vi.fn(),
    isPersistenceConfigured: vi.fn(),
    plannerMock: vi.fn(),
  }));

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.1" }),
}));
vi.mock("./session", () => ({ readSessionCredential }));
vi.mock("./database", () => ({
  isPersistenceConfigured,
  getPool: () => {
    throw new Error("no pool in this test");
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

import { buildDashboard } from "./actions";

const here = path.dirname(fileURLToPath(import.meta.url));
const wideCsv = readFileSync(
  path.join(
    here,
    "..",
    "..",
    "..",
    "fixtures",
    "sample",
    "operating-spend-wide.csv",
  ),
);

function sampleForm(request: string): FormData {
  const form = new FormData();
  form.set("source", "sample");
  form.set("request", request);
  return form;
}

beforeEach(() => {
  readSessionCredential.mockResolvedValue(undefined);
  isPersistenceConfigured.mockReturnValue(false);
  plannerMock.mockReturnValue(new FakePlanningProvider());
});

describe("buildDashboard from the sample", () => {
  it("builds a dashboard, returns the plan, and says how the file was read", async () => {
    const result = await buildDashboard(
      sampleForm("Where is the money going?"),
    );
    expect(result.ok).toBe(true);
    expect(result.dashboard?.pages.length).toBeGreaterThan(0);
    expect(result.plan?.planVersion).toBe("table-plan-v1");
    expect(result.mapping).toMatch(/Amount/u);
    expect(result.source).toEqual({ kind: "sample" });
    expect(result.usesModel).toBe(false);
    expect(result.dashboardId).toBeUndefined();
  });

  it("refuses an empty request", async () => {
    const result = await buildDashboard(sampleForm("   "));
    expect(result).toEqual({
      ok: false,
      error: "Say what the dashboard should show.",
    });
  });

  it("refuses a request over the length limit", async () => {
    const result = await buildDashboard(sampleForm("x".repeat(501)));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/limited to 500/u);
  });

  it("applies a refinement to the previous plan", async () => {
    const first = await buildDashboard(sampleForm("Spending by category"));
    expect(first.ok).toBe(true);
    const form = sampleForm("Spending by category");
    form.set("plan", JSON.stringify(first.plan));
    form.set("instruction", "Just the overview");
    const refined = await buildDashboard(form);
    expect(refined.ok).toBe(true);
    expect(refined.plan?.pages.length).toBe(1);
    expect(refined.dashboard?.pages.length).toBe(1);
  });

  it("reports a refinement that changes nothing", async () => {
    const first = await buildDashboard(sampleForm("Spending by category"));
    const form = sampleForm("Spending by category");
    form.set("plan", JSON.stringify(first.plan));
    form.set("instruction", "keep everything exactly as it is");
    const refined = await buildDashboard(form);
    expect(refined.ok).toBe(true);
    expect(refined.refinement).toBe("already-satisfied");
  });

  it("refuses a refinement whose plan cannot be parsed", async () => {
    const form = sampleForm("Spending by category");
    form.set("plan", "{not json");
    form.set("instruction", "Quarterly");
    const result = await buildDashboard(form);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not recognised/u);
  });
});

describe("buildDashboard from an upload", () => {
  it("reads a wide budget export and builds a dashboard", async () => {
    const form = new FormData();
    form.set("request", "Which lines are over budget?");
    form.set("file", new File([wideCsv], "spend.csv", { type: "text/csv" }));
    const result = await buildDashboard(form);
    expect(result.ok).toBe(true);
    expect(result.source).toEqual({ kind: "upload" });
    expect(JSON.stringify(result.dashboard)).toMatch(/Cloud infrastructure/u);
  });

  it("refuses a missing file with a sentence", async () => {
    const form = new FormData();
    form.set("request", "Anything");
    const result = await buildDashboard(form);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Choose a CSV/u);
  });

  it("refuses a file that is not a table with the reason", async () => {
    const form = new FormData();
    form.set("request", "Anything");
    form.set(
      "file",
      new File(["a sentence with no header or rows"], "notes.csv", {
        type: "text/csv",
      }),
    );
    const result = await buildDashboard(form);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/could not be read/u);
  });
});

describe("saving", () => {
  it("does not try to save when nobody is signed in", async () => {
    isPersistenceConfigured.mockReturnValue(true);
    readSessionCredential.mockResolvedValue(undefined);
    const result = await buildDashboard(sampleForm("Spending by category"));
    expect(result.ok).toBe(true);
    expect(result.dashboardId).toBeUndefined();
    expect(result.error).toBeUndefined();
  });

  // The landing page builds the sample nobody asked for. Mocking the session
  // away cannot see this: the bug was that a signed-in visitor warming the page
  // wrote into their own organization, so the session must be PRESENT here.
  it("never saves a build marked persist=no, even for a signed-in reader", async () => {
    isPersistenceConfigured.mockReturnValue(true);
    readSessionCredential.mockResolvedValue({
      tokenKeyVersion: 1,
      token: Buffer.alloc(32, 7),
    });
    const form = sampleForm("Where is the money going?");
    form.set("persist", "no");
    const result = await buildDashboard(form);
    expect(result.ok).toBe(true);
    expect(result.dashboardId).toBeUndefined();
    // getPool throws in this suite, so reaching persistence at all would surface
    // as the "could not be saved" sentence rather than a silent pass.
    expect(result.error).toBeUndefined();
  });

  it("does attempt to save a build the reader asked for", async () => {
    isPersistenceConfigured.mockReturnValue(true);
    readSessionCredential.mockResolvedValue({
      tokenKeyVersion: 1,
      token: Buffer.alloc(32, 7),
    });
    const result = await buildDashboard(sampleForm("Spending by category"));
    expect(result.ok).toBe(true);
    expect(result.error).toMatch(/could not be saved/u);
  });
});
