import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import metadata from "../../../fixtures/ucr/campus-facts-2025.meta.json";
import capturedSnapshot from "../../../fixtures/ucr/campus-facts-2025.snapshot.json";
import {
  buildUcrEnrollmentDashboard,
  parseUcrCampusFactsHtml,
} from "./ucr-campus-facts";

const fixturePath = fileURLToPath(
  new URL("../../../fixtures/ucr/campus-facts-2025.html", import.meta.url),
);
const html = readFileSync(fixturePath, "utf8");

function parse(input = html) {
  return parseUcrCampusFactsHtml(input, {
    retrievedAt: metadata.retrievedAt,
    sourceUrl: metadata.sourceUrl,
  });
}

describe("the official UCR Fall enrollment source", () => {
  it("parses to the exact snapshot the product will consume", () => {
    expect(parse(html)).toEqual(capturedSnapshot);
  });

  it("parses the census definition and ten-year enrollment table", () => {
    const snapshot = parse();

    expect(snapshot.term).toBe("Fall 2025");
    expect(snapshot.censusDefinition).toBe(
      "Counts represent distinct students who are enrolled in credit-bearing classes as of the fall third-week census.",
    );
    expect(snapshot.history).toHaveLength(10);
    expect(snapshot.history[0]).toEqual({
      year: 2016,
      undergraduate: 19_799,
      graduate: 3_122,
      total: 22_921,
    });
    expect(snapshot.history.at(-1)).toEqual({
      year: 2025,
      undergraduate: 24_034,
      graduate: 3_599,
      total: 27_633,
    });
  });

  it("keeps source identity and retrieval provenance", () => {
    expect(parse()).toMatchObject({
      institution: "University of California, Riverside",
      sourceName: "UC Riverside Institutional Research",
      sourceUrl: "https://ir.ucr.edu/campus-facts-tables",
      retrievedAt: metadata.retrievedAt,
    });
  });
});

describe("a changed or contradictory source", () => {
  it("rejects when the overview and latest table total disagree", () => {
    const changed = html.replace(
      "In the Fall 2025 term, 27,633 students",
      "In the Fall 2025 term, 27,634 students",
    );
    expect(() => parse(changed)).toThrow(/overview disagrees/u);
  });

  it("rejects row arithmetic that no longer sums", () => {
    const changed = html.replace(
      ">27,633</td></tr></tbody></table>",
      ">27,634</td></tr></tbody></table>",
    );
    expect(() => parse(changed)).toThrow(/arithmetic fails/u);
  });

  it("rejects a missing census definition", () => {
    const changed = html.replace(
      "Counts represent distinct students",
      "Values represent students",
    );
    expect(() => parse(changed)).toThrow(/census definition/u);
  });

  it("rejects a heading whose term disagrees with the table", () => {
    const changed = html.replace(
      "Enrollment - Fall 2025",
      "Enrollment - Fall 2026",
    );
    expect(() => parse(changed)).toThrow(/term disagree/u);
  });

  it("rejects coherent heading/table drift when the overview still names the real term", () => {
    const changed = html
      .replace("Enrollment - Fall 2025", "Enrollment - Fall 2026")
      .replace(
        "<strong>2025</strong></span></th></tr></thead>",
        "<strong>2026</strong></span></th></tr></thead>",
      );
    expect(() => parse(changed)).toThrow(/overview and section term disagree/u);
  });

  it("rejects another URL and malformed retrieval time", () => {
    expect(() =>
      parseUcrCampusFactsHtml(html, {
        retrievedAt: metadata.retrievedAt,
        sourceUrl: "https://example.com/enrollment",
      }),
    ).toThrow(/approved official source/u);
    expect(() =>
      parseUcrCampusFactsHtml(html, {
        retrievedAt: "not-a-date",
        sourceUrl: metadata.sourceUrl,
      }),
    ).toThrow();
  });
});

describe("the enrollment dashboard experiment", () => {
  it("builds a contract-valid non-sensor dashboard from the parsed snapshot", () => {
    const dashboard = buildUcrEnrollmentDashboard(parse());

    expect(dashboard.schemaVersion).toBe("1.2");
    expect(dashboard.title).toBe("UC Riverside Enrollment — Fall 2025");
    expect(dashboard.freshness).toEqual({
      status: "partial",
      label: "Official Fall 2025 third-week census snapshot; not real-time",
    });
    expect(
      dashboard.pages.flatMap((page) =>
        page.components.map((component) => component.kind),
      ),
    ).toEqual(["summary", "metric-grid", "ranking"]);
  });

  it("shows current totals and a computed comparable-year change", () => {
    const dashboard = buildUcrEnrollmentDashboard(parse());
    const metrics = dashboard.pages[0]!.components.find(
      (component) => component.kind === "metric-grid",
    );
    if (metrics?.kind !== "metric-grid") throw new Error("metric grid missing");

    expect(metrics.metrics).toEqual([
      expect.objectContaining({
        label: "Total enrollment",
        value: "27,633",
        change: "+4.7% year over year",
        direction: "up",
      }),
      expect.objectContaining({
        label: "Undergraduate",
        value: "24,034",
        change: "87.0% of total",
      }),
      expect.objectContaining({
        label: "Graduate",
        value: "3,599",
        change: "13.0% of total",
      }),
    ]);
  });

  it("does not invent stations, sensors, or an exact census timestamp", () => {
    const dashboard = buildUcrEnrollmentDashboard(parse());
    const rendered = JSON.stringify(dashboard);

    expect(rendered).not.toMatch(
      /\b(?:gauge|monitor|sensor|station-map|station-table)\b/iu,
    );
    expect(dashboard.freshness.latestObservationAt).toBeUndefined();
    expect(dashboard.evidence[0]?.observedAt).toBeUndefined();
    expect(dashboard.notice).toContain("not infer current-day attendance");
  });
});
