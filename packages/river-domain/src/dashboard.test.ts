import { describe, expect, it } from "vitest";

import fixture from "../../../fixtures/usgs/sacramento-instantaneous-values.json";
import { createRiverDashboard } from "./dashboard";
import { parseUsgsInstantaneousValues } from "./usgs";

describe("createRiverDashboard", () => {
  const gauges = parseUsgsInstantaneousValues(fixture);
  const dashboard = createRiverDashboard(gauges, {
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

  it("creates a validated multi-page river dashboard", () => {
    expect(dashboard.schemaVersion).toBe("1.1");
    expect(dashboard.pages.map((page) => page.title)).toEqual([
      "Overview",
      "Gauge details",
    ]);
    expect(dashboard.freshness.status).toBe("partial");
    expect(dashboard.dataMode).toBe("demo");
    expect(dashboard.nextAction.title).toMatch(/American River/);
  });

  it("creates exact deterministic executive brief claims and evidence", () => {
    expect(dashboard.executiveBrief).toEqual({
      known: {
        headline: "3 gauges monitored",
        detail:
          "1 gauge is rising and 1 gauge is falling based on fresh water-level readings.",
        evidenceIds: [
          "usgs-11446500",
          "usgs-11447650",
          "usgs-11370500",
          "calculated-trends",
        ],
      },
      changed: {
        headline: "Sacramento River rose fastest",
        detail:
          "The fastest fresh, complete material one-hour rise is +0.3 ft at SACRAMENTO R A FREEPORT CA.",
        evidenceIds: ["usgs-11447650", "calculated-trends"],
      },
      important: {
        headline: "3 items need attention",
        detail:
          "Highest priority: American River — Water-level reading is more than two hours old",
        evidenceIds: ["usgs-11446500", "calculated-trends", "usgs-11447650"],
      },
    });
  });

  it("includes map, current metrics, rankings, trends, alerts, and evidence", () => {
    const kinds = dashboard.pages.flatMap((page) =>
      page.components.map((component) => component.kind),
    );
    expect(kinds).toEqual(
      expect.arrayContaining([
        "summary",
        "metric-grid",
        "gauge-map",
        "ranking",
        "alert-list",
        "gauge-table",
        "trend-list",
      ]),
    );
    expect(dashboard.evidence).toHaveLength(4);

    const overview = dashboard.pages[0]!;
    const alertComponent = overview.components.find(
      (component) => component.kind === "alert-list",
    );
    expect(alertComponent).toMatchObject({ kind: "alert-list" });
    if (alertComponent?.kind === "alert-list") {
      expect(
        alertComponent.alerts.some(
          (alert) => alert.id === "freeport-demo-threshold",
        ),
      ).toBe(true);
    }
  });

  it("uses claim-level evidence and ranks only fresh rising gauges", () => {
    const summary = dashboard.pages[0]!.components.find(
      (component) => component.kind === "summary",
    );
    expect(summary?.kind).toBe("summary");
    if (summary?.kind === "summary") {
      expect(summary.claims).toHaveLength(3);
      expect(
        summary.claims.every((claim) => claim.evidenceIds.length > 0),
      ).toBe(true);
    }

    const ranking = dashboard.pages[0]!.components.find(
      (component) => component.id === "fastest-rising",
    );
    expect(ranking?.kind).toBe("ranking");
    if (ranking?.kind === "ranking") {
      expect(ranking.items.every((item) => !item.value.startsWith("-"))).toBe(
        true,
      );
    }
  });

  it("does not call the least-negative falling gauge fastest-rising", () => {
    const fallingGauges = gauges.slice(0, 2).map((gauge) => {
      const copy = structuredClone(gauge);
      copy.stage!.observations = copy.stage!.observations.map(
        (observation, index) => ({ ...observation, value: 20 - index }),
      );
      return copy;
    });
    const fallingDashboard = createRiverDashboard(fallingGauges, {
      asOf: "2026-07-29T12:02:00.000Z",
    });
    const ranking = fallingDashboard.pages[0]!.components.find(
      (component) => component.id === "fastest-rising",
    );
    expect(ranking?.kind).toBe("ranking");
    if (ranking?.kind === "ranking") expect(ranking.items).toHaveLength(0);
    expect(fallingDashboard.executiveBrief.changed).toEqual({
      headline: "No material one-hour rise available",
      detail:
        "No fresh, complete gauge rose more than 0.05 ft over the last hour.",
      evidenceIds: ["usgs-11446500", "usgs-11447650", "calculated-trends"],
    });
  });

  it("states that configured checks are clear when no alert needs attention", () => {
    const clearDashboard = createRiverDashboard(
      gauges.filter((gauge) => gauge.siteId !== "11446500"),
      {
        asOf: "2026-07-29T12:02:00.000Z",
      },
    );

    expect(clearDashboard.executiveBrief.important).toEqual({
      headline: "Configured checks are clear",
      detail:
        "No data-quality or user-defined threshold checks need attention.",
      evidenceIds: ["usgs-11447650", "usgs-11370500", "calculated-trends"],
    });
  });

  it("does not make current-condition or threshold claims from stale stage data", () => {
    const staleGauge = structuredClone(
      gauges.find((gauge) => gauge.siteId === "11447650")!,
    );
    const staleDashboard = createRiverDashboard([staleGauge], {
      asOf: "2026-07-29T16:30:00.000Z",
      thresholds: [
        {
          id: "stale-threshold",
          siteId: staleGauge.siteId,
          label: "Stale threshold",
          stageAbove: 1,
        },
      ],
    });
    const summary = staleDashboard.pages[0]!.components.find(
      (component) => component.kind === "summary",
    );
    expect(summary?.kind).toBe("summary");
    if (summary?.kind === "summary") {
      expect(summary.claims[0]!.text).toMatch(/^0 gauges are rising/);
    }
    expect(staleDashboard.executiveBrief.known.detail).toBe(
      "0 gauges are rising and 0 gauges are falling based on fresh water-level readings.",
    );
    expect(staleDashboard.executiveBrief.changed).toEqual({
      headline: "No material one-hour rise available",
      detail:
        "No fresh, complete gauge rose more than 0.05 ft over the last hour.",
      evidenceIds: ["usgs-11447650", "calculated-trends"],
    });
    expect(staleDashboard.executiveBrief.important.headline).toBe(
      "2 items need attention",
    );
    expect(staleDashboard.executiveBrief.important.detail).toContain(
      "Water-level reading is more than two hours old",
    );
    expect(staleDashboard.executiveBrief.important.detail).not.toContain(
      "Stale threshold",
    );
    const alertList = staleDashboard.pages[0]!.components.find(
      (component) => component.kind === "alert-list",
    );
    expect(alertList?.kind).toBe("alert-list");
    if (alertList?.kind === "alert-list") {
      expect(
        alertList.alerts.some((alert) => alert.id === "stale-threshold"),
      ).toBe(false);
    }
  });

  it("explains the architecture in plain language and records that AI is disabled", () => {
    expect(dashboard.architecture.nodes.map((node) => node.label)).toEqual(
      expect.arrayContaining([
        "River gauge readings",
        "Check and organize",
        "Calculate change",
        "AI dashboard planner",
        "Two dashboard pages",
      ]),
    );
    expect(dashboard.architecture.summary).toMatch(/does not use AI/i);
  });
});
