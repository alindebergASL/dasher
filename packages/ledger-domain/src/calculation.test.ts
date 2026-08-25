import { describe, expect, it } from "vitest";

import { operatingSpendFixture } from "./fixture";

import { calculateLedger, engineTimestamp } from "./calculation";
import { ZERO, abs, add, compare, ratioToPercent, subtract } from "./exact";
import { LedgerSnapshotSchema, type LedgerSnapshot } from "./ledger";

/**
 * The ledger's figures, as `@dasher/calculation-engine` computes them.
 *
 * What is worth testing here is not that arithmetic works — the engine has 303
 * tests for that — but the seam: that the snapshot becomes an input table the
 * engine accepts, that the graph asks for the right thing, and that the rows
 * coming back are attached to the lines they belong to.
 */

const snapshot = operatingSpendFixture();
const latest = snapshot.periods.at(-1) as string;
const first = snapshot.periods[0] as string;

const withLines = (lines: LedgerSnapshot["lines"]): LedgerSnapshot =>
  LedgerSnapshotSchema.parse({ ...snapshot, lines });

describe("calculateLedger", () => {
  const result = calculateLedger(snapshot);
  const cell = (lineId: string, period: string) =>
    result.cells.find(
      (one) => one.lineId === lineId && one.period === period,
    ) as (typeof result.cells)[number];

  it("builds one row per line per period", () => {
    expect(result.rowCount).toBe(
      snapshot.lines.length * snapshot.periods.length,
    );
    expect(result.cells).toHaveLength(result.rowCount);
  });

  it("hashes the input table it built", () => {
    // The sha256 the engine computed over the exact input bytes. A workbook
    // arriving here later gets the same treatment, which is the point of going
    // through `canonical-input-table-v1` rather than passing an array.
    expect(result.inputSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  /**
   * THE PROPERTY THIS SLICE EXISTS FOR, STATED AS IT MEASURES.
   *
   * The float version summed the latest period's shares to 99.99999999999999,
   * and the test written for it asserted `toBeCloseTo(100, 6)` — a tolerance
   * that hid the defect rather than finding it.
   *
   * The exact version is not "always exactly one", and claiming that would be
   * the same kind of overclaim in the other direction. Six ratios each rounded
   * half-even to ten places need not sum to one place-value; rounding residue is
   * inherent. Measured over this fixture, four of the six periods sum to exactly
   * 1 and two land one unit in the last place away — 2026-03 at +1e-10 and
   * 2026-07 at -1e-10.
   *
   * What changed is the KIND of error. The float residue came from binary
   * representation and bore no relation to any precision anyone asked for; this
   * one is bounded by the scale the graph requests, and at the one decimal place
   * the dashboard prints it cannot be seen. The displayed period is exact.
   */
  it("sums the displayed period's shares to exactly one", () => {
    const sum = result.cells
      .filter((one) => one.period === latest)
      .reduce((total, one) => add(total, one.share ?? ZERO), ZERO);

    expect(sum).toBe("1");
  });

  it("keeps every period within one unit of the requested scale", () => {
    for (const period of snapshot.periods) {
      const sum = result.cells
        .filter((one) => one.period === period)
        .reduce((total, one) => add(total, one.share ?? ZERO), ZERO);
      const residual = abs(subtract(sum, "1"));

      // 1e-10 on the ratio is 1e-8 of a percentage point.
      expect(compare(residual, "0.0000000001")).toBeLessThanOrEqual(0);
    }
  });

  it("broadcasts one period total across that period's rows", () => {
    const totals = new Set(
      result.cells
        .filter((one) => one.period === latest)
        .map((one) => one.periodTotal),
    );

    expect([...totals]).toStrictEqual(["474855"]);
  });

  it("reports no change in the first period rather than a change of zero", () => {
    // A missing previous period is not a period in which nothing moved. The
    // engine says `missing`; reading that as zero would put every line on the
    // "steady" side of a comparison it never took part in.
    expect(cell("cloud", first).change).toBeNull();
    expect(cell("cloud", first).changePercent).toBeNull();
    expect(cell("cloud", latest).change).toBe("3565");
  });

  it("attaches each row's figures to the line it came from", () => {
    // The engine orders rows by a hash of their key fields, not by the order
    // they were built in. Reading them positionally against the input put
    // `travel`'s figures on `salaries` the first time this ran, and every
    // individual value was correct while the dashboard was wrong.
    expect(cell("salaries", latest).amount).toBe("309400");
    expect(cell("travel", latest).amount).toBe("16950");
    expect(ratioToPercent(cell("salaries", latest).share as string)).toBe(
      "65.15673206",
    );
  });

  it("computes the total's own change, and agrees across every line", () => {
    const answers = new Set(
      result.cells
        .filter((one) => one.period === latest)
        .map((one) => one.totalChangePercent),
    );

    // One answer, because the period total is the same on every row of the
    // period and its change is therefore the same too.
    expect(answers.size).toBe(1);
    expect([...answers][0]).toBe("0.23112969");
  });
});

/**
 * The schema accepts more spellings of an instant than the committed fixture
 * uses, and the first version of the conversion handled only that one.
 */
describe("the timestamp handed to the engine", () => {
  it.each([
    ["2026-08-24T09:00:00.000Z", "2026-08-24T09:00:00.000000Z"],
    // No fractional seconds at all.
    ["2026-08-24T09:00:00Z", "2026-08-24T09:00:00.000000Z"],
    // An offset rather than Z, resolved to UTC in both directions.
    ["2026-08-24T09:00:00+01:00", "2026-08-24T08:00:00.000000Z"],
    ["2026-08-24T09:00:00-08:00", "2026-08-24T17:00:00.000000Z"],
    // Already microseconds, and finer than the engine carries.
    ["2026-08-24T09:00:00.123456Z", "2026-08-24T09:00:00.123456Z"],
    ["2026-08-24T09:00:00.1234567Z", "2026-08-24T09:00:00.123456Z"],
  ])("reads %j as %j", (given, expected) => {
    expect(engineTimestamp(given)).toBe(expected);
  });

  it("runs the whole calculation on each of them", () => {
    // `.replace("Z", "000Z")` produced `invalid_graph` on four of these six, so
    // a snapshot stamped with an offset built no dashboard at all.
    for (const retrievedAt of [
      "2026-08-24T09:00:00Z",
      "2026-08-24T09:00:00+01:00",
      "2026-08-24T09:00:00.123456Z",
    ]) {
      const shifted = LedgerSnapshotSchema.parse({ ...snapshot, retrievedAt });

      expect(calculateLedger(shifted).cells).toHaveLength(
        snapshot.lines.length * snapshot.periods.length,
      );
    }
  });

  it("refuses a string that is not an instant", () => {
    expect(() => engineTimestamp("2026-08-24")).toThrow(/RFC3339/u);
    expect(() => engineTimestamp("2026-13-45T99:00:00Z")).toThrow();
  });
});

describe("when a denominator is zero", () => {
  /**
   * The engine refuses `x / 0` outright rather than returning a null, which is
   * right and which the ledger has to answer for. These say what a reader gets.
   */
  const nothingSpent = calculateLedger(
    withLines([
      {
        id: "only",
        label: "Only line",
        amounts: ["0", "0", "0", "0", "0", "0"],
      },
    ]),
  );

  it("still returns every row, with no share", () => {
    expect(nothingSpent.cells).toHaveLength(snapshot.periods.length);
    expect(nothingSpent.cells.every((one) => one.share === null)).toBe(true);
  });

  it("keeps the figures that do not need a denominator", () => {
    const last = nothingSpent.cells.find(
      (one) => one.period === latest,
    ) as (typeof nothingSpent.cells)[number];

    expect(last.amount).toBe("0");
    expect(last.periodTotal).toBe("0");
    // A change of zero is a real answer; a percentage of it is not.
    expect(last.change).toBe("0");
    expect(last.changePercent).toBeNull();
  });

  it("drops the ratios only when it has to", () => {
    // A line that starts at zero and then moves has no percentage change in the
    // period after zero — so the whole snapshot loses its ratios, and this says
    // so rather than leaving it to be discovered.
    const fromZero = calculateLedger(
      withLines([
        {
          id: "only",
          label: "Only line",
          amounts: ["0", "0", "0", "0", "0", "500"],
        },
      ]),
    );
    const last = fromZero.cells.find(
      (one) => one.period === latest,
    ) as (typeof fromZero.cells)[number];

    expect(last.amount).toBe("500");
    expect(last.change).toBe("500");
    expect(last.share).toBeNull();
    expect(last.changePercent).toBeNull();
  });
});
