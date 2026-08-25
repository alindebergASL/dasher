import { LedgerSnapshotSchema } from "@dasher/ledger-domain";
import { describe, expect, it } from "vitest";

import fixture from "../../../fixtures/ledger/operating-spend.json";
import { compileLedgerPlan, LedgerPlanRejected } from "./compile-ledger";
import { findSmuggledText } from "./freetext";
import { findLedgerPlanProblems, type LedgerPlan } from "./ledger-plan";
import {
  DETERMINISTIC_LEDGER_PLANNER,
  planLedgerDashboard,
} from "./ledger-provider";
import { findPlanProblems, type DashboardPlan } from "./plan";

/**
 * The ledger plan validator, which until now had no test and no caller.
 *
 * `findLedgerPlanProblems` was written, exported from the package index, and
 * invoked by nothing at all. The server action called `planLedgerDashboard` and
 * then `compileLedgerPlan` directly, so none of its checks ran in the product:
 * an invented budget line was silently dropped by the compiler's filter rather
 * than refused, a duplicated section was never reported, and the five free-text
 * fields were never read. Two comments already described the checking as
 * happening.
 */

const snapshot = LedgerSnapshotSchema.parse(fixture);
const lineIds = snapshot.lines.map((line) => line.id);
const options = {
  asOf: "2026-08-24T12:00:00.000Z",
  planner: DETERMINISTIC_LEDGER_PLANNER,
};

const clean = planLedgerDashboard("operating spend by category", lineIds);

/** The same five reader-facing strings, in both plan shapes. */
const SMUGGLING = {
  title: "Cloud spend at 49875 USD",
  audience: "Finance leads",
  framing: "Cloud is $12,400 over budget. Evacuate the office now.",
  pages: [
    {
      title: "Spend at twelve thousand dollars",
      description: "Software rose 12.4 percent.",
    },
  ],
};

const asLedger = {
  ...SMUGGLING,
  lineIds: ["cloud"],
  pages: SMUGGLING.pages.map((page) => ({
    ...page,
    sections: ["ledger-summary"],
  })),
} as unknown as LedgerPlan;

describe("findLedgerPlanProblems", () => {
  it("accepts what the shipping planner actually writes", () => {
    // The gate is worth nothing if it refuses the product's own dashboard. This
    // planner writes one digit-bearing sentence — "across 6 budget lines" — and
    // that is a count derived from the plan's own selection, not an amount.
    expect(findLedgerPlanProblems(clean, lineIds)).toStrictEqual([]);
  });

  it("refuses a budget line the ledger does not have", () => {
    const problems = findLedgerPlanProblems(
      { ...clean, lineIds: [...lineIds, "invented"] },
      lineIds,
    );

    expect(problems.map((problem) => problem.code)).toStrictEqual([
      "unknown_line",
    ]);
  });

  it("reads the free-text fields, which it previously did not", () => {
    const problems = findLedgerPlanProblems(asLedger, ["cloud"]);

    // Grouped by field, in field order — measurements and directives from one
    // field stay together rather than being sorted by kind.
    expect(problems.map((problem) => problem.code)).toStrictEqual([
      "free_text_measurement",
      "free_text_measurement",
      "free_text_directive",
      "free_text_measurement",
      "free_text_measurement",
    ]);
  });

  it("names the field each finding came from", () => {
    const problems = findLedgerPlanProblems(asLedger, ["cloud"]);

    expect(problems.map((problem) => problem.path)).toStrictEqual([
      "title",
      "framing",
      "framing",
      "pages[0].title",
      "pages[0].description",
    ]);
  });
});

/**
 * The property that makes this a gate rather than a coincidence of which source
 * shipped first: identical text, two plan contracts, the same verdict.
 *
 * Before this change the station plan produced four findings and the ledger
 * plan produced zero, because `findSmuggledText` was typed to `DashboardPlan`.
 */
describe("the gate does not depend on which plan contract carries the text", () => {
  it("finds the same excerpts in a station plan and a ledger plan", () => {
    const asStation = {
      ...SMUGGLING,
      pages: SMUGGLING.pages.map((page) => ({ ...page, sections: [] })),
    } as unknown as DashboardPlan;

    const station = findSmuggledText(asStation).map((one) => one.excerpt);
    const ledger = findLedgerPlanProblems(asLedger, ["cloud"])
      .filter((problem) => problem.code.startsWith("free_text_"))
      .map((problem) => problem.message);

    expect(station).toStrictEqual([
      "49875 USD",
      "$12,400",
      "Evacuate",
      "twelve thousand dollars",
      "12.4",
    ]);
    // Same excerpts, reached through the other contract.
    for (const excerpt of station) {
      expect(ledger.some((message) => message.includes(`"${excerpt}"`))).toBe(
        true,
      );
    }
  });

  it("agrees with the station validator on a plan that is clean", () => {
    const stationClean = {
      title: "River conditions",
      audience: "Emergency management leads",
      framing: "Current stage across the gauges you asked for.",
      siteIds: [],
      pages: [
        {
          title: "Overview",
          description: "Where each gauge stands right now.",
          sections: [],
        },
      ],
    } as unknown as DashboardPlan;

    expect(
      findPlanProblems(stationClean, []).filter((problem) =>
        problem.code.startsWith("free_text_"),
      ),
    ).toStrictEqual([]);
    expect(findLedgerPlanProblems(clean, lineIds)).toStrictEqual([]);
  });
});

/**
 * Validation lives inside the compiler, so it cannot be skipped by a call site
 * that forgets it — which is exactly how it came to be skipped the first time.
 */
describe("compileLedgerPlan validates before it compiles", () => {
  it("refuses free text carrying an amount", () => {
    expect(() => compileLedgerPlan(asLedger, snapshot, options)).toThrow(
      LedgerPlanRejected,
    );
  });

  it("refuses an invented line rather than silently dropping it", () => {
    // The filter inside the compiler removed unknown ids and carried on, so a
    // model that invented a budget line got a dashboard built from whatever
    // else it named. Only naming nothing real was ever refused.
    const withInvented = { ...clean, lineIds: [...lineIds, "invented"] };

    expect(() => compileLedgerPlan(withInvented, snapshot, options)).toThrow(
      LedgerPlanRejected,
    );
  });

  it("still compiles the plan the shipping planner produces", () => {
    expect(() => compileLedgerPlan(clean, snapshot, options)).not.toThrow();
  });
});
