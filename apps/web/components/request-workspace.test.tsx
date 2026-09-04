import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { PlanResult } from "../app/planning";
import { sampleDashboard } from "../test/sample-spec";

import { RequestWorkspace } from "./request-workspace";

const { buildDashboard } = vi.hoisted(() => ({ buildDashboard: vi.fn() }));
vi.mock("@/app/actions", () => ({ buildDashboard }));

let initial: PlanResult;

beforeAll(async () => {
  const built = await sampleDashboard();
  initial = {
    ok: true,
    dashboard: built.dashboard,
    plan: built.plan,
    mapping: "Read Amount as the figure and Category as the grouping.",
    source: { kind: "sample" },
    attempts: 1,
    usesModel: false,
  };
});

beforeEach(() => {
  buildDashboard.mockReset();
});

function lastForm(): FormData {
  const call = buildDashboard.mock.calls.at(-1);
  expect(call).toBeDefined();
  return call![0] as FormData;
}

describe("RequestWorkspace", () => {
  it("renders the initial dashboard and how the file was read", () => {
    render(<RequestWorkspace initial={initial} initialRequest="Where?" />);
    expect(
      screen.getByRole("heading", { level: 1, name: initial.dashboard!.title }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Read Amount as the figure/u)).toBeInTheDocument();
    expect(screen.getByText(/built-in planner/u)).toBeInTheDocument();
  });

  it("builds against the sample when no file is chosen", async () => {
    buildDashboard.mockResolvedValue(initial);
    render(<RequestWorkspace initial={initial} initialRequest="Where?" />);
    fireEvent.change(screen.getByLabelText("What do you want to see?"), {
      target: { value: "Spending by category" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Build dashboard" }));
    await waitFor(() => expect(buildDashboard).toHaveBeenCalledTimes(1));
    const form = lastForm();
    expect(form.get("source")).toBe("sample");
    expect(form.get("request")).toBe("Spending by category");
    expect(form.get("plan")).toBeNull();
  });

  it("sends the previous plan and the instruction on a refinement", async () => {
    buildDashboard.mockResolvedValue({ ...initial, refinement: undefined });
    render(<RequestWorkspace initial={initial} initialRequest="Where?" />);
    fireEvent.change(screen.getByLabelText("Change this dashboard"), {
      target: { value: "Just the overview" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply change" }));
    await waitFor(() => expect(buildDashboard).toHaveBeenCalledTimes(1));
    const form = lastForm();
    expect(form.get("instruction")).toBe("Just the overview");
    expect(JSON.parse(String(form.get("plan")))).toEqual(initial.plan);
    expect(form.get("request")).toBe("Where?");
  });

  it("shows a refusal as an alert and keeps the dashboard", async () => {
    buildDashboard.mockResolvedValue({
      ok: false,
      error: "Say what you want.",
    });
    render(<RequestWorkspace initial={initial} initialRequest="Where?" />);
    fireEvent.click(screen.getByRole("button", { name: "Build dashboard" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Say what you want."),
    );
    expect(
      screen.getByRole("heading", { level: 1, name: initial.dashboard!.title }),
    ).toBeInTheDocument();
  });

  it("links to a saved dashboard", async () => {
    buildDashboard.mockResolvedValue({
      ...initial,
      dashboardId: "11111111-1111-4111-8111-111111111111",
    });
    render(<RequestWorkspace initial={initial} initialRequest="Where?" />);
    fireEvent.click(screen.getByRole("button", { name: "Build dashboard" }));
    const link = await screen.findByRole("link", {
      name: "Open this dashboard by link",
    });
    expect(link).toHaveAttribute(
      "href",
      "/d/11111111-1111-4111-8111-111111111111",
    );
  });

  it("says when a refinement changed nothing", async () => {
    buildDashboard.mockResolvedValue({
      ...initial,
      refinement: "already-satisfied",
    });
    render(<RequestWorkspace initial={initial} initialRequest="Where?" />);
    fireEvent.click(screen.getByRole("button", { name: "Exclude salaries" }));
    await screen.findByText(/already looks like that/u);
  });
});
