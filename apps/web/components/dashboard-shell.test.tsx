import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { parseDashboardSpec } from "@dasher/dashboard-schema";

import { DashboardShell } from "./dashboard-shell";

/**
 * A spreadsheet-derived dashboard with every component kind the renderer
 * knows, built through `parseDashboardSpec` so the fixture is held to the same
 * contract the running app's compiler output is.
 */
const dashboard = parseDashboardSpec({
  schemaVersion: "1.2",
  id: "quarterly-spend",
  title: "Quarterly Spend Review",
  audience: "Finance leaders",
  generatedAt: "2026-07-29T12:02:00.000Z",
  dataMode: "demo",
  freshness: {
    status: "fresh",
    label: "Read from the July workbook",
    latestObservationAt: "2026-07-29T12:00:00.000Z",
  },
  nextAction: {
    title: "Review marketing spend",
    detail: "Marketing is 12% over plan; confirm the campaign accruals.",
    evidenceIds: ["recommended-1"],
  },
  notice: "Figures come from the uploaded workbook, not an accounting system.",
  pages: [
    {
      id: "overview",
      title: "Overview",
      description: "Position, movement, and anything needing attention.",
      components: [
        {
          id: "summary",
          kind: "summary",
          title: "What matters",
          tone: "normal",
          evidenceIds: ["observed-1", "calculated-1"],
          claims: [
            {
              text: "Spend is tracking to budget.",
              evidenceIds: ["calculated-1"],
            },
            {
              text: "Three departments reported.",
              evidenceIds: ["observed-1"],
            },
            {
              text: "Marketing is the only department over plan.",
              evidenceIds: ["calculated-1", "interpreted-1"],
            },
          ],
        },
        {
          id: "headline-metrics",
          kind: "metric-grid",
          title: "Headline figures",
          evidenceIds: ["calculated-1"],
          metrics: [
            {
              label: "Total spend",
              value: "$248,300",
              evidenceIds: ["calculated-1"],
            },
            { label: "Budget", value: "$250,000", evidenceIds: ["observed-1"] },
            {
              label: "Variance",
              value: "-$1,700",
              change: "-0.7%",
              direction: "down",
              evidenceIds: ["calculated-1"],
            },
            { label: "Departments", value: "3", evidenceIds: ["observed-1"] },
          ],
        },
        {
          id: "fastest-growing",
          kind: "ranking",
          title: "Fastest growing",
          evidenceIds: ["calculated-1"],
          items: [
            {
              id: "marketing",
              label: "Field operations",
              value: "+9%",
              evidenceIds: ["calculated-1"],
            },
          ],
        },
        {
          id: "attention",
          kind: "alert-list",
          title: "Attention",
          evidenceIds: ["interpreted-1"],
          alerts: [
            {
              id: "marketing-over",
              severity: "attention",
              title: "Marketing over budget",
              detail: "Spend has exceeded plan for three consecutive months.",
              evidenceIds: ["interpreted-1"],
            },
          ],
        },
      ],
    },
    {
      id: "details",
      title: "Details",
      description: "Line items and recent movement.",
      components: [
        {
          id: "by-department",
          kind: "table",
          title: "Spend by department",
          evidenceIds: ["observed-1"],
          columns: ["Department", "Spend", "Change"],
          rows: [
            {
              id: "operations",
              cells: ["Operations", "$152,850", "+4%"],
              evidenceIds: ["observed-1", "calculated-1"],
            },
            {
              id: "marketing",
              cells: ["Marketing", "$48,200", "+12%"],
              evidenceIds: ["observed-1", "calculated-1"],
            },
            {
              id: "support",
              cells: ["Support", "$47,250", ""],
              evidenceIds: ["observed-1"],
            },
          ],
        },
        {
          id: "monthly-trends",
          kind: "trend-list",
          title: "Monthly spend",
          evidenceIds: ["observed-1"],
          series: [
            {
              id: "total",
              label: "Total spend",
              unit: "USD",
              evidenceIds: ["observed-1"],
              points: [
                { at: "2026-05-31T00:00:00.000Z", value: 80_100 },
                { at: "2026-06-30T00:00:00.000Z", value: 82_400 },
                { at: "2026-07-29T00:00:00.000Z", value: 85_800 },
              ],
            },
          ],
        },
      ],
    },
  ],
  evidence: [
    {
      id: "observed-1",
      kind: "observed",
      label: "Workbook cells",
      sourceName: "Uploaded workbook",
      sourceUrl: "https://example.com/uploads/spend.xlsx",
      observedAt: "2026-07-29T12:00:00.000Z",
      retrievedAt: "2026-07-29T12:01:00.000Z",
      detail: "Sheet 'Spend', rows 2-4.",
      confidence: "high",
    },
    {
      id: "calculated-1",
      kind: "calculated",
      label: "Totals and variance",
      sourceName: "Dasher calculation",
      retrievedAt: "2026-07-29T12:01:00.000Z",
      detail: "Summed per department and compared with the budget column.",
      confidence: "high",
    },
    {
      id: "interpreted-1",
      kind: "interpreted",
      label: "Over-budget reading",
      sourceName: "Dasher rules",
      retrievedAt: "2026-07-29T12:01:00.000Z",
      detail:
        "A department is flagged when spend exceeds plan by more than 10%.",
      confidence: "medium",
    },
    {
      id: "recommended-1",
      kind: "recommended",
      label: "Suggested review",
      sourceName: "Dasher rules",
      retrievedAt: "2026-07-29T12:01:00.000Z",
      detail: "The flagged department is the one to look at first.",
      confidence: "medium",
    },
  ],
  architecture: {
    title: "How this dashboard works",
    summary:
      "Dasher read the uploaded workbook, computed every number itself, and no model was called.",
    nodes: [
      {
        id: "workbook",
        label: "Uploaded workbook",
        detail: "The spreadsheet as it was uploaded.",
        kind: "input",
      },
      {
        id: "calculate",
        label: "Calculate",
        detail: "Totals, variance, and thresholds.",
        kind: "process",
      },
      {
        id: "pages",
        label: "Dashboard pages",
        detail: "Overview and details.",
        kind: "page",
      },
    ],
    edges: [
      { from: "workbook", to: "calculate", label: "cells" },
      { from: "calculate", to: "pages", label: "figures" },
    ],
  },
  executiveBrief: {
    known: {
      statementTypes: ["observed", "calculated"],
      headline: "3 departments reported",
      detail: "Every department in the workbook has a July figure.",
      evidenceIds: ["observed-1", "calculated-1"],
    },
    changed: {
      statementTypes: ["calculated"],
      headline: "Marketing rose fastest",
      detail: "Marketing spend is up 12% on June.",
      evidenceIds: ["calculated-1"],
    },
    important: {
      statementTypes: ["interpreted"],
      headline: "1 department needs attention",
      detail: "Marketing is over plan for the third month running.",
      evidenceIds: ["interpreted-1"],
    },
  },
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
    for (const headline of [
      "3 departments reported",
      "Marketing rose fastest",
      "1 department needs attention",
      "Review marketing spend",
    ]) {
      expect(within(brief).getByText(headline)).toBeInTheDocument();
    }
    for (const detail of [
      "Every department in the workbook has a July figure.",
      "Marketing spend is up 12% on June.",
      "Marketing is over plan for the third month running.",
      "Marketing is 12% over plan; confirm the campaign accruals.",
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

  it("shows the brief only on the first page without a separate mobile next card", () => {
    const { container } = render(<DashboardShell dashboard={dashboard} />);

    expect(
      screen.getByRole("region", { name: "Executive brief" }),
    ).toBeInTheDocument();
    expect(container.querySelector(".mobile-next")).not.toBeInTheDocument();
    expect(container.querySelector(".sidebar-next")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /02Details/i }));
    expect(
      screen.queryByRole("region", { name: "Executive brief" }),
    ).not.toBeInTheDocument();
    expect(container.querySelector(".sidebar-next")).toBeInTheDocument();
  });

  it("renders the overview, freshness state, and safe next action", () => {
    render(<DashboardShell dashboard={dashboard} />);
    expect(screen.getByText("Quarterly Spend Review")).toBeInTheDocument();
    expect(
      screen.getAllByText("Read from the July workbook").length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText("Review marketing spend").length,
    ).toBeGreaterThan(0);
    expect(screen.getByText("Demo dashboard")).toBeInTheDocument();
    expect(screen.getByText("What matters")).toBeInTheDocument();
  });

  it("says nothing about a latest observation when there is no instant", () => {
    // A period-based source has no moment of observation and names its period
    // in the freshness label instead; the heading must not render a unit on a
    // non-value.
    const freshness = { ...dashboard.freshness };
    delete (freshness as { latestObservationAt?: string }).latestObservationAt;
    render(<DashboardShell dashboard={{ ...dashboard, freshness }} />);

    expect(screen.queryByText(/Unknown/u)).not.toBeInTheDocument();
    expect(screen.queryByText("Latest observation")).not.toBeInTheDocument();
    expect(
      screen.getAllByText(dashboard.freshness.label).length,
    ).toBeGreaterThan(0);
  });

  it("switches between dashboard pages", () => {
    render(<DashboardShell dashboard={dashboard} />);
    fireEvent.click(screen.getByRole("button", { name: /02Details/i }));
    expect(screen.getByText("Spend by department")).toBeInTheDocument();
    expect(screen.getByText("Monthly spend")).toBeInTheDocument();
  });

  it("renders a table component's columns, rows, and per-row evidence", () => {
    render(<DashboardShell dashboard={dashboard} />);
    fireEvent.click(screen.getByRole("button", { name: /02Details/i }));

    const table = screen.getByRole("table");
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((header) => header.textContent),
    ).toEqual(["Department", "Spend", "Change", "Evidence"]);
    // One header row plus one row per spec row.
    expect(within(table).getAllByRole("row")).toHaveLength(4);
    expect(within(table).getByText("$152,850")).toBeInTheDocument();
    expect(within(table).getByText("Support")).toBeInTheDocument();

    fireEvent.click(
      within(table).getByRole("button", {
        name: "Evidence for Operations row",
      }),
    );
    const dialog = screen.getByRole("dialog", { name: "Sources and evidence" });
    expect(within(dialog).getByText("Workbook cells")).toBeInTheDocument();
    expect(within(dialog).getByText("Totals and variance")).toBeInTheDocument();
  });

  it("opens the plain-language architecture diagram", () => {
    render(<DashboardShell dashboard={dashboard} />);
    fireEvent.click(screen.getByRole("button", { name: /architecture/i }));
    expect(
      screen.getByRole("dialog", { name: "How this dashboard works" }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Uploaded workbook").length).toBeGreaterThan(0);
    expect(screen.getByText(/no model was called/i)).toBeInTheDocument();
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

  it("opens evidence with a direct source citation", () => {
    render(<DashboardShell dashboard={dashboard} />);
    fireEvent.click(
      screen.getAllByRole("button", { name: /view .* sources?/i })[0]!,
    );
    expect(
      screen.getByRole("dialog", { name: "Sources and evidence" }),
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole("link", { name: /open Uploaded workbook source/i })
        .length,
    ).toBeGreaterThan(0);
  });

  it("opens evidence for ranking, alert, and table-row claims", () => {
    render(<DashboardShell dashboard={dashboard} />);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Evidence for Field operations ranking",
      }),
    );
    expect(
      screen.getByRole("dialog", { name: "Sources and evidence" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close evidence" }));

    fireEvent.click(
      screen.getByRole("button", {
        name: "Evidence for Marketing over budget alert",
      }),
    );
    expect(
      screen.getByRole("dialog", { name: "Sources and evidence" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close evidence" }));

    fireEvent.click(screen.getByRole("button", { name: /02Details/i }));
    fireEvent.click(
      screen.getByRole("button", { name: "Evidence for Marketing row" }),
    );
    expect(
      screen.getByRole("dialog", { name: "Sources and evidence" }),
    ).toBeInTheDocument();
  });

  it("opens evidence for an individual summary claim", () => {
    render(<DashboardShell dashboard={dashboard} />);
    fireEvent.click(
      screen.getByRole("button", {
        name: /Evidence for: .*tracking to budget/i,
      }),
    );
    expect(
      screen.getByRole("dialog", { name: "Sources and evidence" }),
    ).toBeInTheDocument();
  });

  it("shows the brief on the landing page whatever that page is called", () => {
    // The gate is "first page", not a page id, so a builder that namespaces
    // its page ids still gets a brief on the page a reader lands on.
    const renamed = parseDashboardSpec({
      ...dashboard,
      pages: [
        { ...dashboard.pages[0]!, id: "spend:overview" },
        ...dashboard.pages.slice(1),
      ],
    });

    render(<DashboardShell dashboard={renamed} />);
    expect(
      screen.getByRole("region", { name: "Executive brief" }),
    ).toBeInTheDocument();
  });

  it("shows the brief on the landing page only, not on every page", () => {
    // The counterweight: "first page" must not degrade into "all pages", or
    // the brief stops being a summary and becomes a banner.
    render(<DashboardShell dashboard={dashboard} />);
    expect(
      screen.getByRole("region", { name: "Executive brief" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Details/ }));
    expect(
      screen.queryByRole("region", { name: "Executive brief" }),
    ).not.toBeInTheDocument();
  });

  it("badges a reopened dashboard as a snapshot, not by its data mode", () => {
    // A stored dashboard is a record of a build that already happened. Its
    // figures may well have been live at the time, so the data-mode badge is
    // the wrong thing to show over bytes frozen last week.
    render(<DashboardShell dashboard={dashboard} sealed />);
    expect(screen.getByText("Saved snapshot")).toBeInTheDocument();
    expect(screen.queryByText("Demo dashboard")).not.toBeInTheDocument();
    expect(screen.queryByText("Live dashboard")).not.toBeInTheDocument();
  });

  it("badges live figures as live when the build is fresh", () => {
    const live = parseDashboardSpec({ ...dashboard, dataMode: "live" });
    render(<DashboardShell dashboard={live} />);
    expect(screen.getByText("Live dashboard")).toBeInTheDocument();
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
