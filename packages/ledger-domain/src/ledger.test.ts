import { describe, expect, it } from "vitest";

import { operatingSpendFixture } from "./fixture";

import * as exact from "./exact";

/**
 * An independent oracle for the engine's percentages, in exact integer
 * arithmetic.
 *
 * These assertions used to compare against the same float expression the code
 * under test used, which made the float the definition of correct — and the
 * comparison only passed because `toBeCloseTo` allowed the disagreement. This
 * computes the ratio as a rational, scales it, and rounds half-even, which is
 * what the engine says it does. Agreeing with it is evidence; agreeing with a
 * double is not.
 */
function percentAt8(numerator: bigint, denominator: bigint): string {
  // One rounding, at the eighth place. The first version scaled to nine digits
  // and rounded twice, which put the last digit one below the engine's — and
  // the engine was right: -4600/44200 is -10.408723981|9004…, and a tail above
  // a half rounds the eighth digit up.
  const scaled = numerator * 100n * 10n ** 8n;
  const negative = scaled < 0n !== denominator < 0n;
  const top = scaled < 0n ? -scaled : scaled;
  const bottom = denominator < 0n ? -denominator : denominator;
  let quotient = top / bottom;
  const twice = (top % bottom) * 2n;
  // Half-even: ties go to the even neighbour, everything else to the nearer.
  if (twice > bottom || (twice === bottom && quotient % 2n === 1n)) {
    quotient += 1n;
  }
  const digits = quotient.toString(10).padStart(9, "0");
  const whole = digits.slice(0, digits.length - 8);
  const fraction = digits.slice(digits.length - 8).replace(/0+$/u, "");
  const body = fraction.length === 0 ? whole : `${whole}.${fraction}`;
  return negative && /[1-9]/u.test(body) ? `-${body}` : body;
}

import {
  deriveLedgerFacts,
  LedgerSnapshotSchema,
  periodStart,
  type LedgerSnapshot,
} from "./ledger";

const snapshot = operatingSpendFixture();

function withLines(lines: LedgerSnapshot["lines"]): LedgerSnapshot {
  return { ...snapshot, lines };
}

describe("LedgerSnapshotSchema", () => {
  it("accepts the committed fixture", () => {
    expect(snapshot.lines).toHaveLength(6);
    expect(snapshot.periods).toHaveLength(6);
  });

  it("refuses a ragged table", () => {
    // The failure a normalized shape exists to exclude. Left through, it
    // surfaces much later as a trend line that quietly stops early.
    const ragged = withLines([
      { ...snapshot.lines[0]!, amounts: ["1", "2", "3"] },
      ...snapshot.lines.slice(1),
    ]);

    expect(() => LedgerSnapshotSchema.parse(ragged)).toThrow(/amounts/u);
  });

  it("refuses duplicate line ids", () => {
    const duplicated = withLines([snapshot.lines[0]!, snapshot.lines[0]!]);

    expect(() => LedgerSnapshotSchema.parse(duplicated)).toThrow(/unique/u);
  });

  it("refuses a period that is not a month", () => {
    expect(() =>
      LedgerSnapshotSchema.parse({
        ...snapshot,
        periods: ["2026-13", "2026-14"],
      }),
    ).toThrow();
  });
});

describe("deriveLedgerFacts", () => {
  const facts = deriveLedgerFacts(snapshot);

  it("totals the latest period from the lines rather than trusting a field", () => {
    // Summed with the exact arithmetic rather than with `+`, now that the
    // amounts are decimal text. Adding them as numbers would make the test's
    // oracle the very thing the ledger stopped using.
    const expected = snapshot.lines.reduce(
      (sum, line) => exact.add(sum, line.amounts.at(-1) as string),
      exact.ZERO,
    );

    expect(facts.total).toBe(expected);
    expect(facts.latestPeriod).toBe("2026-08");
    expect(facts.previousPeriod).toBe("2026-07");
  });

  it("computes shares that sum to a hundred, exactly", () => {
    /**
     * This asserted `toBeCloseTo(100, 6)`, and the tolerance was not a judgement
     * about display precision — it was there because the float sum was
     * 99.99999999999999. Now the shares come back from the calculation engine as
     * exact decimals and the column a reader could add up by hand adds up.
     */
    const sum = facts.lines.reduce(
      // Every line in this fixture has a share; a null here would be the bug
      // this sum exists to catch, so it fails loudly rather than summing as
      // zero and still reaching 100 by luck.
      (total, line) => exact.add(total, line.share as string),
      exact.ZERO,
    );

    // Was `every(share !== null)`, which could not fail on either revision:
    // this fixture has no zero denominator, so the guard proved nothing. The sum
    // below is the real assertion, and a null would make `add` throw.
    expect(sum).toBe("100");
  });

  it("ranks movers by size of change, not by direction", () => {
    // Contractors fell by more than anything rose. A ranking that sorted by
    // signed change would bury the largest movement in the ledger.
    expect(facts.movers[0]?.id).toBe("contractors");
    expect(exact.sign(facts.movers[0]?.change as string)).toBe(-1);
  });

  it("breaks a tie between equal moves by id, so runs agree", () => {
    const flat = withLines(
      snapshot.lines.map((line, index) => ({
        ...line,
        id: index === 0 ? "aaa" : index === 1 ? "bbb" : line.id,
        amounts: line.amounts.map(() => "100"),
      })),
    );

    expect(deriveLedgerFacts(flat).movers.map((line) => line.id)).toStrictEqual(
      deriveLedgerFacts(flat).movers.map((line) => line.id),
    );
    expect(deriveLedgerFacts(flat).movers[0]?.id).toBe("aaa");
  });

  it("names only the lines actually over their budget", () => {
    expect(facts.overBudget.map((line) => line.id)).toStrictEqual([
      "cloud",
      "software",
    ]);
    expect(facts.overBudget[0]?.overBudgetBy).toBe(String(49875 - 42000));
  });

  it("treats a line with no budget as not compared, not as zero", () => {
    // A missing budget read as zero would put every unbudgeted line over.
    const unbudgeted = withLines(
      snapshot.lines.map((line) => {
        const withoutBudget = { ...line };
        delete withoutBudget.budgetPerPeriod;
        return withoutBudget;
      }),
    );

    expect(deriveLedgerFacts(unbudgeted).overBudget).toStrictEqual([]);
  });

  it("reports no percent change when the previous period was zero", () => {
    const fromZero = withLines([
      {
        id: "only",
        label: "Only line",
        amounts: ["0", "0", "0", "0", "0", "500"],
      },
    ]);

    expect(deriveLedgerFacts(fromZero).totalChangePercent).toBeNull();
    expect(deriveLedgerFacts(fromZero).lines[0]?.changePercent).toBeNull();
  });

  it("gives every line its own evidence, plus one calculation record", () => {
    expect(facts.evidence).toHaveLength(snapshot.lines.length + 1);
    expect(facts.lineEvidenceIds).toHaveLength(snapshot.lines.length);
    expect(
      facts.evidence.find((item) => item.id === facts.calculationEvidenceId)
        ?.kind,
    ).toBe("calculated");
  });

  it("carries no station vocabulary into its evidence", () => {
    // The property the whole package exists for, asserted on what it produces
    // rather than on what it imports.
    expect(JSON.stringify(facts)).not.toMatch(
      /siteId|latitude|longitude|gauge|river|station/iu,
    );
  });
});

describe("periodStart", () => {
  it("turns a month into an instant the contract accepts", () => {
    expect(periodStart("2026-03")).toBe("2026-03-01T00:00:00.000Z");
  });
});

/**
 * The values, not just their shapes.
 *
 * The mutation gate scored this file at 55.79% when the suite checked totals,
 * ordering and counts but not the numbers or the sentences underneath them.
 * Every figure here is one a reader sees on a dashboard.
 */
/**
 * The period ordering the rest of the file assumes, now that two things depend
 * on it: the facts read the latest period off the end of the array, and the
 * calculation engine orders its rows by the period value.
 */
describe("periods must run oldest first, once each", () => {
  const withPeriods = (periods: string[]) => ({
    ...snapshot,
    periods,
    lines: snapshot.lines.map((line) => ({
      ...line,
      amounts: line.amounts.slice(0, periods.length),
    })),
  });

  it("accepts the ascending order the fixture uses", () => {
    expect(() =>
      LedgerSnapshotSchema.parse(
        withPeriods(["2026-03", "2026-04", "2026-05"]),
      ),
    ).not.toThrow();
  });

  it("refuses newest-first, which used to report a change of zero", () => {
    // Unchecked, this produced a dashboard naming 2026-03 as the latest period
    // and its change as 0, because the engine had correctly found nothing
    // earlier to compare against while the reader saw a line that had fallen.
    expect(() =>
      LedgerSnapshotSchema.parse(
        withPeriods(["2026-05", "2026-04", "2026-03"]),
      ),
    ).toThrow(/oldest first/u);
  });

  it("refuses a repeated period, which the engine could only call invalid_graph", () => {
    expect(() =>
      LedgerSnapshotSchema.parse(
        withPeriods(["2026-03", "2026-03", "2026-04"]),
      ),
    ).toThrow(/appear once each/u);
  });
});

describe("the values deriveLedgerFacts computes", () => {
  const facts = deriveLedgerFacts(snapshot);
  const line = (id: string) => facts.lines.find((one) => one.id === id)!;
  const raw = (id: string) => snapshot.lines.find((one) => one.id === id)!;

  it("takes each line's latest and previous from the last two periods", () => {
    expect(line("cloud").latest).toBe(raw("cloud").amounts.at(-1));
    expect(line("cloud").previous).toBe(raw("cloud").amounts.at(-2));
  });

  it("computes change as latest minus previous, keeping the sign", () => {
    expect(line("cloud").change).toBe(
      exact.subtract(
        raw("cloud").amounts.at(-1) as string,
        raw("cloud").amounts.at(-2) as string,
      ),
    );
    expect(exact.sign(line("contractors").change)).toBe(-1);
  });

  it("computes percent change against the previous period", () => {
    const one = line("contractors");

    expect(one.changePercent).toBe(
      percentAt8(
        BigInt(raw("contractors").amounts.at(-1) as string) -
          BigInt(raw("contractors").amounts.at(-2) as string),
        BigInt(raw("contractors").amounts.at(-2) as string),
      ),
    );
    // The value the engine actually returned, pinned so a scale or rounding
    // change has to be looked at rather than absorbed by the oracle too.
    expect(one.changePercent).toBe("-10.40723982");
  });

  it("computes share against the period total, not against a budget", () => {
    // Ten fractional digits on the ratio, so the percentage carries eight.
    expect(line("salaries").share).toBe(
      percentAt8(
        BigInt(raw("salaries").amounts.at(-1) as string),
        BigInt(
          snapshot.lines.reduce(
            (sum, one) => exact.add(sum, one.amounts.at(-1) as string),
            exact.ZERO,
          ),
        ),
      ),
    );
    expect(line("salaries").share).toBe("65.15673206");
  });

  it("computes how far over budget a line is, not merely that it is", () => {
    expect(line("cloud").overBudgetBy).toBe(
      exact.subtract(
        line("cloud").latest,
        raw("cloud").budgetPerPeriod as string,
      ),
    );
    expect(line("facilities").overBudgetBy).toBeUndefined();
  });

  it("carries the previous total so a change can be shown, not just computed", () => {
    expect(facts.previousTotal).toBe(
      snapshot.lines.reduce(
        (sum, one) => exact.add(sum, one.amounts.at(-2) as string),
        exact.ZERO,
      ),
    );
    expect(facts.totalChangePercent).toBe(
      percentAt8(
        BigInt(facts.total) - BigInt(facts.previousTotal),
        BigInt(facts.previousTotal),
      ),
    );
  });

  it("names share of total in the calculation evidence when it was computed", () => {
    const detail = facts.evidence.find(
      (item) => item.id === facts.calculationEvidenceId,
    )?.detail;

    expect(detail).toBe(
      "Totals, period-over-period change, share of total, and budget comparisons are computed by Dasher from the recorded amounts. Amounts are in USD.",
    );
  });

  it("drops share of total from that record when it was not computed", () => {
    /*
     * The evidence panel is where a reader goes to check a figure, and this
     * record is cited behind every one of them. It listed "share of total"
     * unconditionally, so on a ledger whose shares were refused it stood at high
     * confidence behind an em dash, asserting a calculation that had not
     * happened. Asserted whole rather than by substring: the failure this
     * catches is one clause remaining in a sentence, which `toContain` would
     * miss in either direction.
     */
    const refused = deriveLedgerFacts(
      withLines([
        { id: "one", label: "One", amounts: ["0", "0", "0", "0", "0", "60"] },
        { id: "two", label: "Two", amounts: ["0", "0", "0", "0", "0", "40"] },
      ]),
    );
    const detail = refused.evidence.find(
      (item) => item.id === refused.calculationEvidenceId,
    )?.detail;

    expect(detail).toBe(
      "Totals, period-over-period change, and budget comparisons are computed by Dasher from the recorded amounts. Share of total was not computed for this ledger, because a period in it totals zero. Amounts are in USD.",
    );
    expect(refused.lines.every((line) => line.share === null)).toBe(true);
  });

  it("refuses a ledger larger than the engine will evaluate, and names the size", () => {
    /*
     * 30 lines over 12 months — an ordinary operating export — is 360 figures
     * and cannot be charted. It used to reach the engine and fail there with
     * `limit_exceeded`, which the upload path reported as "That export read
     * correctly but no dashboard could be built from it": true, unactionable,
     * and indistinguishable from a malformed file.
     */
    const tooBig = {
      ...snapshot,
      periods: Array.from(
        { length: 12 },
        (_, index) => `2026-${String(index + 1).padStart(2, "0")}`,
      ),
      lines: Array.from({ length: 30 }, (_, index) => ({
        id: `l${String(index)}`,
        label: `Line ${String(index)}`,
        amounts: Array.from({ length: 12 }, () => "100"),
      })),
    };

    const refusal = LedgerSnapshotSchema.safeParse(tooBig);

    expect(refusal.success).toBe(false);
    expect(refusal.error?.issues[0]?.message).toBe(
      "this export has 30 lines across 12 periods, which is 360 figures; Dasher can build a dashboard from at most 250",
    );
  });

  it("accepts a ledger exactly at the ceiling", () => {
    // The boundary is measured, not assumed: 250 builds and 260 does not.
    const atCeiling = {
      ...snapshot,
      periods: Array.from(
        { length: 25 },
        (_, index) =>
          `20${String(26 + Math.floor(index / 12))}-${String((index % 12) + 1).padStart(2, "0")}`,
      ),
      lines: Array.from({ length: 10 }, (_, index) => ({
        id: `l${String(index)}`,
        label: `Line ${String(index)}`,
        amounts: Array.from({ length: 25 }, () => "100"),
      })),
    };

    expect(LedgerSnapshotSchema.safeParse(atCeiling).success).toBe(true);
    expect(() =>
      deriveLedgerFacts(LedgerSnapshotSchema.parse(atCeiling)),
    ).not.toThrow();
  });

  it("keeps latest minus previous equal to the change it reports", () => {
    /*
     * The `delta` node declared `scale: i64:0`, so `change` was the one figure
     * on the page rounded to whole units while the two amounts it sits between
     * stayed exact. Measured before the repair: 10.00 -> 10.40 reported a change
     * of "0", and 10.00 -> 9.40 reported "-1" — a $0.60 fall shown as a dollar,
     * and a real move shown as none at all.
     */
    for (const amounts of [
      ["100", "160"],
      ["100.00", "101.20"],
      ["10.00", "10.40"],
      ["10.00", "9.40"],
      ["0.75", "0.80"],
    ]) {
      const line = deriveLedgerFacts(
        LedgerSnapshotSchema.parse({
          ...snapshot,
          periods: ["2026-07", "2026-08"],
          lines: [{ id: "only", label: "Only", amounts }],
        }),
      ).lines[0]!;

      expect(line.change).toBe(exact.subtract(line.latest, line.previous));
    }
  });

  it("names the source and the period span in each line's evidence", () => {
    const evidence = facts.evidence.find(
      (item) => item.id === line("cloud").evidenceId,
    );

    expect(evidence?.label).toBe("Cloud infrastructure amounts");
    expect(evidence?.sourceName).toBe(snapshot.sourceName);
    expect(evidence?.detail).toContain(
      `${String(snapshot.periods.length)} months`,
    );
    expect(evidence?.detail).toContain("ending 2026-08");
    expect(evidence?.kind).toBe("observed");
  });

  it("names the currency in the calculation evidence", () => {
    const evidence = facts.evidence.find(
      (item) => item.id === facts.calculationEvidenceId,
    );

    expect(evidence?.detail).toContain(snapshot.currency);
    expect(evidence?.sourceName).toBe("Dasher calculations");
  });

  it("orders over-budget lines by how far over they are", () => {
    expect(facts.overBudget.map((one) => one.id)).toStrictEqual(
      [...facts.overBudget]
        .sort((a, b) => exact.compare(b.overBudgetBy!, a.overBudgetBy!))
        .map((one) => one.id),
    );
  });

  it("reports no share at all when there was no total to divide by", () => {
    const empty = withLines([
      {
        id: "only",
        label: "Only line",
        amounts: ["0", "0", "0", "0", "0", "0"],
      },
    ]);
    const derived = deriveLedgerFacts(empty);

    expect(derived.total).toBe("0");
    /*
     * This asserted `"0"`, and the comment beside it said what reaches the
     * reader is "a zero share and a summary that says the total". Neither half
     * was true: the summary said nothing about the total, and the zero was
     * `deriveLedgerFacts` substituting a literal for a null the engine had
     * refused to compute. A line holding an unknown share is not a line holding
     * none of the budget, and the type now carries the difference.
     */
    expect(derived.lines[0]?.share).toBeNull();
    expect(derived.lines[0]?.changePercent).toBeNull();
  });

  it("keeps a real zero share distinguishable from an absent one", () => {
    // The distinction the null exists to make. This line genuinely spent
    // nothing out of a non-zero total, so its share is a measured zero — and it
    // must not read the same as the case above.
    const spentNothing = withLines([
      {
        id: "idle",
        label: "Idle line",
        amounts: ["0", "0", "0", "0", "0", "0"],
      },
      {
        id: "busy",
        label: "Busy line",
        amounts: ["100", "100", "100", "100", "100", "100"],
      },
    ]);
    const derived = deriveLedgerFacts(spentNothing);

    expect(derived.lines.find((one) => one.id === "idle")?.share).toBe("0");
    expect(derived.lines.find((one) => one.id === "busy")?.share).toBe("100");
  });

  it("keeps the period vocabulary the source supplied", () => {
    expect(facts.periodLabel).toBe(snapshot.periodLabel);
    expect(facts.currency).toBe(snapshot.currency);
    expect(facts.latestPeriod).toBe(snapshot.periods.at(-1));
  });
});
