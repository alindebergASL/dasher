import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { PlanResult } from "../app/planning";
import { sampleDashboard } from "../test/sample-spec";

import { RequestWorkspace } from "./request-workspace";

const { buildDashboard } = vi.hoisted(() => ({ buildDashboard: vi.fn() }));
vi.mock("@/app/actions", () => ({ buildDashboard }));

interface StageOneInterpretation {
  readonly primaryMeasure: string;
  readonly period: string;
  readonly otherMeasures: readonly string[];
  readonly identifiers: readonly string[];
}

let successful: PlanResult & { interpretation: StageOneInterpretation };

beforeAll(async () => {
  const built = await sampleDashboard();
  successful = {
    ok: true,
    dashboard: built.dashboard,
    plan: built.plan,
    mapping: "Read Total Spend as the figure and Month as the period.",
    source: { kind: "upload" },
    attempts: 1,
    usesModel: false,
    interpretation: {
      primaryMeasure: "Total Spend",
      period: "Month",
      otherMeasures: ["Revenue", "Headcount", "Customer Count"],
      identifiers: ["Chassis ID", "Product Code", "Priority Rank"],
    },
  };
});

describe("stage 1 request workspace interpretation strip", () => {
  it("renders one calm dataset interpretation with one correction action", () => {
    render(
      <RequestWorkspace
        initial={successful}
        initialRequest="Show the operating picture"
      />,
    );

    const strips = screen.queryAllByRole("region", {
      name: "Dataset interpretation",
    });
    expect(strips).toHaveLength(1);
    const strip = strips[0]!;
    expect(strip).toHaveTextContent(/Total Spend/u);
    expect(strip).toHaveTextContent(/Month/u);
    expect(strip).toHaveTextContent(/Revenue/u);
    expect(strip).toHaveTextContent(/Headcount/u);
    expect(strip).toHaveTextContent(/Customer Count/u);
    expect(strip).toHaveTextContent(/Chassis ID/u);
    expect(strip).toHaveTextContent(/Product Code/u);
    expect(strip).toHaveTextContent(/Priority Rank/u);
    expect(strip).toHaveTextContent(/dataset/iu);
    expect(strip).not.toHaveTextContent(/\b(?:file|spreadsheet|csv)\b/iu);
    expect(
      within(strip).getAllByRole("button", {
        name: /correct interpretation/iu,
      }),
    ).toHaveLength(1);
    expect(within(strip).getAllByRole("button")).toHaveLength(1);
    for (const status of screen.getAllByRole("status")) {
      expect(status).not.toHaveTextContent(/Read Total Spend as the figure/iu);
    }

    const requestInput = screen.getByRole("textbox", {
      name: "What should this dashboard answer?",
    });
    const heading = screen.getByRole("heading", {
      level: 1,
      name: successful.dashboard!.title,
    });
    const changeInput = screen.getByRole("textbox", {
      name: "Change this dashboard",
    });
    expect(requestInput.compareDocumentPosition(strip)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(strip.compareDocumentPosition(heading)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(heading.compareDocumentPosition(changeInput)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("moves focus to the existing refinement input for correction", () => {
    render(
      <RequestWorkspace
        initial={successful}
        initialRequest="Show the operating picture"
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /correct interpretation/iu }),
    );

    expect(
      screen.getByRole("textbox", { name: /change this dashboard/iu }),
    ).toHaveFocus();
  });

  it("announces an asynchronous build independently of mobile-hidden prose", async () => {
    buildDashboard.mockResolvedValueOnce(successful);
    render(
      <RequestWorkspace
        initial={successful}
        initialRequest="Show the operating picture"
      />,
    );

    const build = screen.getByRole("button", { name: /build dashboard/iu });
    fireEvent.submit(build.closest("form")!);
    await waitFor(() => expect(buildDashboard).toHaveBeenCalledTimes(1));

    await waitFor(() =>
      expect(
        screen.getByRole("status", { name: "Dashboard update" }),
      ).toHaveTextContent(/Dashboard updated for Show the operating picture/iu),
    );
  });

  it("keeps mobile controls in the same semantic order as the layout", () => {
    render(
      <RequestWorkspace
        initial={successful}
        initialRequest="Show the operating picture"
      />,
    );

    const build = screen.getByRole("button", { name: /build dashboard/iu });
    const architecture = screen.getByRole("button", {
      name: /architecture/iu,
    });
    const correct = screen.getByRole("button", {
      name: /correct interpretation/iu,
    });
    const change = screen.getByRole("textbox", {
      name: /change this dashboard/iu,
    });

    expect(
      build.compareDocumentPosition(correct) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      correct.compareDocumentPosition(architecture) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      architecture.compareDocumentPosition(change) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("keeps the mobile-hidden composer labels in the accessibility tree", () => {
    render(
      <RequestWorkspace
        initial={successful}
        initialRequest="Show the operating picture"
      />,
    );

    expect(screen.getByLabelText("Choose a CSV data source")).toHaveAttribute(
      "aria-label",
      "Choose a CSV data source",
    );
    expect(
      screen.getByRole("textbox", {
        name: "What should this dashboard answer?",
      }),
    ).toHaveAttribute("aria-label", "What should this dashboard answer?");
  });
});
