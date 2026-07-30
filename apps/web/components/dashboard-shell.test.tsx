import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import fixture from "../../../fixtures/usgs/sacramento-instantaneous-values.json";
import {
  createRiverDashboard,
  parseUsgsInstantaneousValues,
} from "@dasher/river-domain";
import { parseDashboardSpec } from "@dasher/dashboard-schema";

import { DashboardShell } from "./dashboard-shell";

const dashboard = createRiverDashboard(parseUsgsInstantaneousValues(fixture), {
  asOf: "2026-07-29T12:02:00.000Z",
  thresholds: [
    {
      id: "freeport-demo-threshold",
      siteId: "11447650",
      label: "Freeport watch level",
      stageAbove: 14.5,
    },
  ],
});

describe("DashboardShell", () => {
  it("renders the overview, freshness state, and safe next action", () => {
    render(<DashboardShell dashboard={dashboard} />);
    expect(screen.getByText("Sacramento River Conditions")).toBeInTheDocument();
    expect(
      screen.getAllByText("1 gauge needs attention").length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText("Review American River gauge").length,
    ).toBeGreaterThan(0);
    expect(screen.getByText("Demo dashboard")).toBeInTheDocument();
    expect(screen.getByText("Conditions summary")).toBeInTheDocument();
  });

  it("switches between dashboard pages", () => {
    render(<DashboardShell dashboard={dashboard} />);
    fireEvent.click(screen.getByRole("button", { name: /02Gauge details/i }));
    expect(screen.getByText("Current readings")).toBeInTheDocument();
    expect(screen.getByText("Recent water-level trends")).toBeInTheDocument();
  });

  it("opens the plain-language architecture diagram", () => {
    render(<DashboardShell dashboard={dashboard} />);
    fireEvent.click(screen.getByRole("button", { name: /architecture/i }));
    expect(
      screen.getByRole("dialog", { name: "How this dashboard works" }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("River gauge readings").length).toBeGreaterThan(
      0,
    );
    expect(screen.getByText(/does not use AI/i)).toBeInTheDocument();
    const closeButton = screen.getByRole("button", {
      name: "Close architecture",
    });
    expect(closeButton).toHaveFocus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(closeButton).toHaveFocus();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(
      screen.queryByRole("dialog", { name: "How this dashboard works" }),
    ).not.toBeInTheDocument();
  });

  it("renders tuple-distinct architecture edges without duplicate React keys", () => {
    const input = structuredClone(dashboard);
    input.architecture.nodes = [
      { id: "a-b", label: "A-B", detail: "First source", kind: "input" },
      { id: "c", label: "C", detail: "First target", kind: "page" },
      { id: "a", label: "A", detail: "Second source", kind: "input" },
      { id: "b-c", label: "B-C", detail: "Second target", kind: "page" },
    ];
    input.architecture.edges = [
      { from: "a-b", to: "c", label: "d" },
      { from: "a", to: "b-c", label: "d" },
    ];
    const collisionSafeDashboard = parseDashboardSpec(input);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const { container } = render(
        <DashboardShell dashboard={collisionSafeDashboard} />,
      );
      fireEvent.click(screen.getByRole("button", { name: /architecture/i }));

      const consoleOutput = errorSpy.mock.calls
        .flat()
        .map((argument) => String(argument))
        .join(" ");
      expect(consoleOutput).not.toMatch(
        /Encountered two children with the same key/,
      );
      expect(
        container.querySelectorAll(".architecture-connection"),
      ).toHaveLength(2);
      expect(screen.getAllByText("d")).toHaveLength(2);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("opens evidence with a direct USGS citation", () => {
    render(<DashboardShell dashboard={dashboard} />);
    fireEvent.click(
      screen.getAllByRole("button", { name: /view .* sources/i })[0]!,
    );
    expect(
      screen.getByRole("dialog", { name: "Sources and evidence" }),
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole("link", {
        name: /open U\.S\. Geological Survey source/i,
      }).length,
    ).toBeGreaterThan(0);
  });

  it("selects a map marker and shows station identity and coordinates", () => {
    render(<DashboardShell dashboard={dashboard} />);
    fireEvent.click(
      screen.getByRole("button", {
        name: /SACRAMENTO R A FREEPORT CA, station 11447650/i,
      }),
    );
    expect(screen.getByText("Station 11447650")).toBeInTheDocument();
    expect(screen.getByText(/38\.4566, -121\.5019/)).toBeInTheDocument();
  });

  it("opens evidence for ranking, alert, and gauge-row claims", () => {
    render(<DashboardShell dashboard={dashboard} />);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Evidence for Sacramento River ranking",
      }),
    );
    expect(
      screen.getByRole("dialog", { name: "Sources and evidence" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close evidence" }));

    fireEvent.click(
      screen.getAllByRole("button", {
        name: "Evidence for American River alert",
      })[0]!,
    );
    expect(
      screen.getByRole("dialog", { name: "Sources and evidence" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close evidence" }));

    fireEvent.click(screen.getByRole("button", { name: /02Gauge details/i }));
    fireEvent.click(
      screen.getByRole("button", {
        name: "Evidence for SACRAMENTO R A FREEPORT CA row",
      }),
    );
    expect(
      screen.getByRole("dialog", { name: "Sources and evidence" }),
    ).toBeInTheDocument();
  });

  it("opens evidence for an individual summary claim", () => {
    render(<DashboardShell dashboard={dashboard} />);
    fireEvent.click(
      screen.getByRole("button", {
        name: /Evidence for: .*gauge.*rising/i,
      }),
    );
    expect(
      screen.getByRole("dialog", { name: "Sources and evidence" }),
    ).toBeInTheDocument();
  });

  it("renders summary claims and metrics without React key errors", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const { container } = render(<DashboardShell dashboard={dashboard} />);

      expect(errorSpy).not.toHaveBeenCalled();
      expect(container.querySelectorAll(".summary-copy > p")).toHaveLength(3);
      expect(container.querySelectorAll(".metric-card")).toHaveLength(4);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
