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
    interpretation: {
      primaryMeasure: "Amount",
      period: "Date",
      otherMeasures: [],
      identifiers: [],
    },
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
  it("renders the initial dashboard and one dataset interpretation", () => {
    render(<RequestWorkspace initial={initial} initialRequest="Where?" />);
    expect(
      screen.getByRole("heading", { level: 1, name: initial.dashboard!.title }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "Dataset interpretation" }),
    ).toHaveTextContent(/Amount as the primary measure/iu);
    expect(
      screen.getByText(/trusted code computes every number/iu),
    ).toBeInTheDocument();
  });

  it("builds against the sample when no file is chosen", async () => {
    buildDashboard.mockResolvedValue(initial);
    render(<RequestWorkspace initial={initial} initialRequest="Where?" />);
    fireEvent.change(
      screen.getByLabelText("What should this dashboard answer?"),
      {
        target: { value: "Spending by category" },
      },
    );
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

  it("presents one source-aware Ask Dasher composer", () => {
    render(<RequestWorkspace initial={initial} initialRequest="Where?" />);

    expect(
      screen.getByRole("heading", { level: 2, name: "Ask Dasher" }),
    ).toBeInTheDocument();
    const request = screen.getByRole("textbox", {
      name: "What should this dashboard answer?",
    });
    expect(request).toBeInstanceOf(HTMLTextAreaElement);
    expect(screen.getByLabelText("Choose a CSV data source")).toHaveAttribute(
      "type",
      "file",
    );
    const sourceStatus = screen.getByRole("status", { name: "Data source" });
    expect(sourceStatus).toHaveTextContent(/Using sample data/iu);
    expect(sourceStatus).toHaveClass("sr-only");
    expect(
      screen.queryByText(/Displayed dashboard:/iu),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(
        /When signed in, uploads are stored as dashboard evidence/iu,
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Use sample data" }),
    ).not.toBeInTheDocument();
  });

  it("keeps the next-build source distinct from the displayed dashboard", async () => {
    buildDashboard.mockResolvedValue(initial);
    render(<RequestWorkspace initial={initial} initialRequest="Where?" />);
    const file = new File(["Date,Amount\n2026-01-01,25"], "operations.csv", {
      type: "text/csv",
    });

    fireEvent.change(screen.getByLabelText("Choose a CSV data source"), {
      target: { files: [file] },
    });

    expect(
      screen.getByRole("status", { name: "Data source" }),
    ).toHaveTextContent(
      /Next build: operations\.csv\. Currently showing: sample data/iu,
    );

    fireEvent.click(screen.getByRole("button", { name: "Build dashboard" }));
    await waitFor(() =>
      expect(
        screen.getByRole("status", { name: "Data source" }),
      ).toHaveTextContent(/Using operations\.csv/iu),
    );
    expect(screen.getByRole("status", { name: "Data source" })).toHaveClass(
      "sr-only",
    );

    fireEvent.click(screen.getByRole("button", { name: "Use sample data" }));
    expect(
      screen.getByRole("status", { name: "Data source" }),
    ).toHaveTextContent(
      /Next build: sample data\. Currently showing: operations\.csv/iu,
    );
  });

  it("preserves a long wrapping question without functional truncation", () => {
    render(<RequestWorkspace initial={initial} initialRequest="Where?" />);
    const request = screen.getByRole("textbox", {
      name: "What should this dashboard answer?",
    });
    const longQuestion =
      "Compare customer growth with headcount by quarter, explain where the relationship changed, and identify the one segment an operator should investigate next.";

    fireEvent.change(request, { target: { value: longQuestion } });

    expect(request).toHaveValue(longQuestion);
    expect(request).toHaveAttribute("rows", "3");
  });

  it("builds from a dropped CSV source", async () => {
    buildDashboard.mockResolvedValue(initial);
    render(<RequestWorkspace initial={initial} initialRequest="Where?" />);
    const file = new File(["Date,Amount\n2026-01-01,25"], "dropped.csv", {
      type: "text/csv",
    });

    fireEvent.drop(screen.getByTestId("source-dropzone"), {
      dataTransfer: { files: [file] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Build dashboard" }));

    await waitFor(() => expect(buildDashboard).toHaveBeenCalledTimes(1));
    expect((lastForm().get("file") as File).name).toBe("dropped.csv");
  });
});
