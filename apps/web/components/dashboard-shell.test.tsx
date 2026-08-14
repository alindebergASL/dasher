import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import fixture from "../../../fixtures/usgs/sacramento-instantaneous-values.json";
import { compilePlan, type DashboardPlan } from "@dasher/planner";
import { parseUsgsInstantaneousValues } from "@dasher/river-domain";
import { parseDashboardSpec } from "@dasher/dashboard-schema";

import { DashboardShell } from "./dashboard-shell";

/**
 * The shell renders what the planner compiles, so the fixture is built the way
 * the running app builds one. It used to come from `createRiverDashboard`, a
 * second composition that nothing rendered — which meant this suite exercised
 * a shape no user ever saw.
 *
 * The plan below reproduces that fixed layout section for section, so the
 * assertions still describe the same dashboard.
 */
const gauges = parseUsgsInstantaneousValues(fixture);

const plan: DashboardPlan = {
  planVersion: "plan-v1",
  title: "Sacramento River Conditions",
  audience: "Regional leaders",
  framing: "Current river conditions for the Sacramento gauges.",
  siteIds: gauges.map((gauge) => gauge.siteId),
  pages: [
    {
      id: "overview",
      title: "Overview",
      description: "Conditions, movement, and anything needing attention.",
      sections: [
        "conditions-summary",
        "headline-metrics",
        "gauge-map",
        "fastest-rising",
        "attention",
      ],
    },
    {
      id: "gauge-details",
      title: "Gauge details",
      description: "Per-gauge readings and recent movement.",
      sections: ["gauge-table", "stage-trends", "change-windows"],
    },
  ],
};

const dashboard = compilePlan(plan, gauges, {
  asOf: "2026-07-29T12:02:00.000Z",
  plannerId: "dashboard-shell-fixture",
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
  it("renders the ordered executive brief before dashboard detail", () => {
    const { container } = render(<DashboardShell dashboard={dashboard} />);
    const brief = screen.getByRole("region", { name: "Executive brief" });
    const list = within(brief).getByRole("list");
    const items = within(list).getAllByRole("listitem");
    const labels = items.map(
      (item) => item.querySelector(".executive-brief-label")?.textContent,
    );

    expect(items).toHaveLength(4);
    expect(labels).toEqual([
      "Known",
      "Changed",
      "Important",
      "Next safe action",
    ]);
    expect(
      items.map(
        (item) => item.querySelector(".executive-statement-types")?.textContent,
      ),
    ).toEqual([
      "Observed · Calculated",
      "Calculated",
      "Interpreted",
      "Recommended",
    ]);
    expect(within(brief).getByText("3 gauges monitored")).toBeInTheDocument();
    expect(
      within(brief).getByText("Sacramento River rose fastest"),
    ).toBeInTheDocument();
    expect(
      within(brief).getByText("3 items need attention"),
    ).toBeInTheDocument();
    expect(
      within(brief).getByText("Review American River gauge"),
    ).toBeInTheDocument();
    for (const detail of [
      "1 gauge is rising and 1 gauge is falling based on fresh water-level readings.",
      "The fastest fresh, complete material one-hour rise is +0.3 ft at SACRAMENTO R A FREEPORT CA.",
      "Highest priority: American River — Water-level reading is more than two hours old",
      "AMERICAN R AT H STREET BRIDGE: Water-level reading is more than two hours old",
    ]) {
      expect(within(brief).getByText(detail)).toBeInTheDocument();
    }

    const dashboardGrid = container.querySelector(".dashboard-grid");
    expect(
      brief.compareDocumentPosition(dashboardGrid!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("opens each brief item's evidence on its first activation and restores focus", () => {
    render(<DashboardShell dashboard={dashboard} />);

    for (const label of ["Known", "Changed", "Important", "Next safe action"]) {
      const trigger = screen.getByRole("button", {
        name: `Evidence for ${label}`,
      });
      trigger.focus();
      fireEvent.click(trigger);

      expect(
        screen.getByRole("dialog", { name: "Sources and evidence" }),
      ).toBeInTheDocument();
      const closeButton = screen.getByRole("button", {
        name: "Close evidence",
      });
      expect(closeButton).toHaveFocus();
      fireEvent.keyDown(window, { key: "Escape" });
      expect(
        screen.queryByRole("dialog", { name: "Sources and evidence" }),
      ).not.toBeInTheDocument();
      expect(trigger).toHaveFocus();
    }
  });

  it("shows the brief only on Overview without a separate mobile next card", () => {
    const { container } = render(<DashboardShell dashboard={dashboard} />);

    expect(
      screen.getByRole("region", { name: "Executive brief" }),
    ).toBeInTheDocument();
    expect(container.querySelector(".mobile-next")).not.toBeInTheDocument();
    expect(container.querySelector(".sidebar-next")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /02Gauge details/i }));
    expect(
      screen.queryByRole("region", { name: "Executive brief" }),
    ).not.toBeInTheDocument();
    expect(container.querySelector(".sidebar-next")).toBeInTheDocument();
  });

  it("counts every evidence-task activation, requires the requested target, and preserves feedback focus", () => {
    render(<DashboardShell dashboard={dashboard} />);

    fireEvent.click(
      screen.getByRole("button", { name: "Session feedback · not saved" }),
    );
    let dialog = screen.getByRole("dialog", { name: "Session feedback" });
    const target = within(dialog).getByLabelText("Requested evidence");
    target.focus();
    fireEvent.change(target, { target: { value: "next-action" } });
    expect(target).toHaveFocus();
    const startTask = within(dialog).getByRole("button", {
      name: "Start evidence task",
    });
    startTask.focus();
    fireEvent.click(startTask);
    expect(startTask).toHaveFocus();
    expect(startTask).toBeEnabled();
    expect(startTask).toHaveTextContent("Task armed");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Close session feedback" }),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Evidence for Changed" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Close evidence" }));
    fireEvent.click(screen.getByRole("button", { name: "Why this action" }));
    fireEvent.click(screen.getByRole("button", { name: "Close evidence" }));

    fireEvent.click(
      screen.getByRole("button", { name: "Session feedback · not saved" }),
    );
    dialog = screen.getByRole("dialog", { name: "Session feedback" });
    expect(
      within(dialog).getByLabelText("Evidence opens this session"),
    ).toHaveTextContent("2");
    expect(
      within(dialog).getByLabelText("Next action reviewed this session"),
    ).toHaveTextContent("Yes");
    expect(
      within(dialog).getByLabelText("Evidence task interactions"),
    ).toHaveTextContent("3");
    expect(
      within(dialog).getByLabelText("Evidence task status"),
    ).toHaveTextContent("Complete");
    expect(
      within(dialog).getByText(/erased when the page reloads/i),
    ).toBeInTheDocument();

    const usefulness = within(dialog).getByRole("radio", { name: "5" });
    usefulness.focus();
    fireEvent.click(usefulness);
    expect(usefulness).toHaveFocus();

    const unclear = within(dialog).getByRole("checkbox", { name: "Unclear" });
    unclear.focus();
    fireEvent.click(unclear);
    expect(unclear).toHaveFocus();

    const need = within(dialog).getByLabelText(
      "Missing information or workflow need",
    );
    need.focus();
    fireEvent.change(need, { target: { value: "Named owner or handoff" } });
    expect(need).toHaveFocus();

    expect(usefulness).toBeChecked();
    expect(unclear).toBeChecked();
    expect(need).toHaveValue("Named owner or handoff");
  });

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
    // The diagram has to be honest about where the model acted. It chose the
    // layout and the framing; it produced no number. The previous fixture came
    // from a composition with no model in it at all and said "does not use
    // AI", which would now be false for what the app actually renders.
    expect(
      screen.getByText(/planning model chose the layout and framing/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Dasher computed every number/i),
    ).toBeInTheDocument();
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
