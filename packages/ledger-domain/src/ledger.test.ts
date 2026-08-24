// @ts-nocheck
import { describe, expect, it } from "vitest";

import fixture from "../../../fixtures/ledger/operating-spend.json";
import {
  deriveLedgerFacts,
  LedgerSnapshotSchema,
  periodStart,
  type LedgerSnapshot,
} from "./ledger";

const snapshot = LedgerSnapshotSchema.parse(fixture);

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
      { ...snapshot.lines[0]!, amounts: [1, 2, 3] },
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
    const expected = snapshot.lines.reduce(
      (sum, line) => sum + line.amounts.at(-1)!,
      0,
    );

    expect(facts.total).toBe(expected);
    expect(facts.latestPeriod).toBe("2026-08");
    expect(facts.previousPeriod).toBe("2026-07");
  });

  it("computes shares that sum to a hundred", () => {
    const sum = facts.lines.reduce((total, line) => total + line.share, 0);

    expect(sum).toBeCloseTo(100, 6);
  });

  it("ranks movers by size of change, not by direction", () => {
    // Contractors fell by more than anything rose. A ranking that sorted by
    // signed change would bury the largest movement in the ledger.
    expect(facts.movers[0]?.id).toBe("contractors");
    expect(facts.movers[0]?.change).toBeLessThan(0);
  });

  it("breaks a tie between equal moves by id, so runs agree", () => {
    const flat = withLines(
      snapshot.lines.map((line, index) => ({
        ...line,
        id: index === 0 ? "aaa" : index === 1 ? "bbb" : line.id,
        amounts: line.amounts.map(() => 100),
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
    expect(facts.overBudget[0]?.overBudgetBy).toBe(49875 - 42000);
  });

  it("treats a line with no budget as not compared, not as zero", () => {
    // A missing budget read as zero would put every unbudgeted line over.
    const unbudgeted = withLines(
      snapshot.lines.map(({ budgetPerPeriod: _budget, ...line }) => line),
    );

    expect(deriveLedgerFacts(unbudgeted).overBudget).toStrictEqual([]);
  });

  it("reports no percent change when the previous period was zero", () => {
    const fromZero = withLines([
      { id: "only", label: "Only line", amounts: [0, 0, 0, 0, 0, 500] },
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
      raw("cloud").amounts.at(-1)! - raw("cloud").amounts.at(-2)!,
    );
    expect(line("contractors").change).toBeLessThan(0);
  });

  it("computes percent change against the previous period", () => {
    const one = line("contractors");

    expect(one.changePercent).toBeCloseTo(
      ((one.latest - one.previous) / one.previous) * 100,
      9,
    );
  });

  it("computes share against the period total, not against a budget", () => {
    expect(line("salaries").share).toBeCloseTo(
      (line("salaries").latest / facts.total) * 100,
      9,
    );
  });

  it("computes how far over budget a line is, not merely that it is", () => {
    expect(line("cloud").overBudgetBy).toBe(
      line("cloud").latest - raw("cloud").budgetPerPeriod!,
    );
    expect(line("facilities").overBudgetBy).toBeUndefined();
  });

  it("carries the previous total so a change can be shown, not just computed", () => {
    expect(facts.previousTotal).toBe(
      snapshot.lines.reduce((sum, one) => sum + one.amounts.at(-2)!, 0),
    );
    expect(facts.totalChangePercent).toBeCloseTo(
      ((facts.total - facts.previousTotal) / facts.previousTotal) * 100,
      9,
    );
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
        .sort((a, b) => b.overBudgetBy! - a.overBudgetBy!)
        .map((one) => one.id),
    );
  });

  it("reports zero share rather than a meaningless one when nothing was spent", () => {
    const empty = withLines([
      { id: "only", label: "Only line", amounts: [0, 0, 0, 0, 0, 0] },
    ]);
    const derived = deriveLedgerFacts(empty);

    expect(derived.total).toBe(0);
    expect(derived.lines[0]?.share).toBe(0);
  });

  it("keeps the period vocabulary the source supplied", () => {
    expect(facts.periodLabel).toBe(snapshot.periodLabel);
    expect(facts.currency).toBe(snapshot.currency);
    expect(facts.latestPeriod).toBe(snapshot.periods.at(-1));
  });
});
