import { describe, expect, it } from "vitest";

import { LedgerSourceSchema, ledgerFromCsv } from "./from-csv";
import { operatingSpendFixture } from "./fixture";

/**
 * The pivot from the shape a spreadsheet writes to the shape the engine wants.
 *
 * The committed export is read through this in both the product and every test
 * that needs a ledger, so the path below is the only way a ledger reaches the
 * compiler. What is worth testing here is the mapping — which column is which,
 * what a blank cell means, and what happens to a file whose columns are not in
 * the order the contract requires.
 */

const source = LedgerSourceSchema.parse({
  sourceName: "Test export",
  retrievedAt: "2026-08-24T09:00:00.000Z",
  currency: "USD",
  periodLabel: "month",
});

const csv = (body: string): string =>
  `line_id,label,budget_per_period,2026-03,2026-04\r\n${body}`;

describe("ledgerFromCsv", () => {
  it("pivots periods across into amounts down", () => {
    const snapshot = ledgerFromCsv(csv("cloud,Cloud,100,10,20\r\n"), source);

    expect(snapshot.periods).toStrictEqual(["2026-03", "2026-04"]);
    expect(snapshot.lines).toStrictEqual([
      {
        id: "cloud",
        label: "Cloud",
        budgetPerPeriod: "100",
        amounts: ["10", "20"],
      },
    ]);
  });

  it("reads a blank budget as not budgeted, not as a budget of zero", () => {
    // The distinction the facts already depend on: a line with no budget is
    // not compared, where a budget of zero would put it over on any spend.
    const snapshot = ledgerFromCsv(csv("cloud,Cloud,,10,20\r\n"), source);

    expect(snapshot.lines[0]?.budgetPerPeriod).toBeUndefined();
  });

  it("refuses a blank amount rather than filling it in", () => {
    // A missing budget is a fact about the ledger. A missing amount is a hole
    // in the table, and a zero there would be a figure nobody recorded.
    expect(() => ledgerFromCsv(csv("cloud,Cloud,100,,20\r\n"), source)).toThrow(
      /decimal text/u,
    );
  });

  it("takes period columns in file order and refuses them out of order", () => {
    // Not sorted into the order the contract wants. A file whose columns run
    // newest first is reported as what it is, because silently reordering it
    // would produce a dashboard whose "latest period" the author never wrote.
    const reversed =
      "line_id,label,budget_per_period,2026-04,2026-03\r\ncloud,Cloud,100,20,10\r\n";

    expect(() => ledgerFromCsv(reversed, source)).toThrow(/oldest first/u);
  });

  it("ignores columns that are not periods or the three it was told about", () => {
    // A real export carries a cost centre code, an owner, a note. Reading only
    // what the mapping declares is what keeps this deterministic.
    const withExtras =
      "line_id,label,budget_per_period,owner,2026-03,2026-04,note\r\n" +
      "cloud,Cloud,100,Ada,10,20,checked\r\n";
    const snapshot = ledgerFromCsv(withExtras, source);

    expect(snapshot.periods).toStrictEqual(["2026-03", "2026-04"]);
    expect(snapshot.lines[0]?.amounts).toStrictEqual(["10", "20"]);
  });

  it("refuses a file with no period column at all", () => {
    const noPeriods = "line_id,label,budget_per_period\r\ncloud,Cloud,100\r\n";

    expect(() => ledgerFromCsv(noPeriods, source)).toThrow(
      /named as a period/u,
    );
  });

  it("names the column a mapping wanted and did not find", () => {
    const renamed =
      "id,label,budget_per_period,2026-03,2026-04\r\nc,C,1,2,3\r\n";

    expect(() => ledgerFromCsv(renamed, source)).toThrow(/"line_id"/u);
  });

  it("trims the cells it reads, so a padded export still maps", () => {
    const padded = csv(" cloud , Cloud , 100 , 10 , 20 \r\n");

    expect(ledgerFromCsv(padded, source).lines[0]).toStrictEqual({
      id: "cloud",
      label: "Cloud",
      budgetPerPeriod: "100",
      amounts: ["10", "20"],
    });
  });

  it("keeps the amount exactly as written, including its cents", () => {
    // The reason the wire format is text. `49875.00` and `0.10` survive as
    // themselves rather than being read back out of a double.
    const cents = csv("cloud,Cloud,100.00,49875.00,0.10\r\n");
    const snapshot = ledgerFromCsv(cents, source);

    expect(snapshot.lines[0]?.amounts).toStrictEqual(["49875.00", "0.10"]);
    expect(snapshot.lines[0]?.budgetPerPeriod).toBe("100.00");
  });
});

describe("the committed export", () => {
  it("is a CSV, and the product reads it through this parser", () => {
    const snapshot = operatingSpendFixture();

    expect(snapshot.sourceName).toBe("Operating ledger export");
    expect(snapshot.currency).toBe("USD");
    expect(snapshot.periods).toStrictEqual([
      "2026-03",
      "2026-04",
      "2026-05",
      "2026-06",
      "2026-07",
      "2026-08",
    ]);
    expect(snapshot.lines).toHaveLength(6);
    // Exact text out of the file, never a number.
    expect(snapshot.lines[0]?.amounts.at(-1)).toBe("49875");
  });
});
