import type { Evidence } from "@dasher/dashboard-schema";
import { z } from "zod";

import {
  type LedgerCell as LedgerCellOf,
  calculateLedger,
} from "./calculation";
import {
  type Exact,
  abs,
  compare,
  fromText,
  ratioToPercent,
  subtract,
} from "./exact";

/**
 * A normalized ledger snapshot, and the facts Dasher derives from one.
 *
 * WHY THIS PACKAGE EXISTS. Every source before it was a station: something with
 * a location, a sensor, and a reading that is fresh or stale. `compilePlan`
 * takes `readonly Station[]`, so a source without coordinates could not reach
 * the renderer through a plan at all — the one non-station dashboard in the
 * product hand-writes its whole `DashboardSpec` as a literal instead. This is
 * the second source that goes through planning and compilation like the first,
 * and it deliberately has no location, no sensor, and no freshness in the
 * sensor sense.
 *
 * WHAT IT IS NOT. It is not a spreadsheet reader. The snapshot arrives already
 * normalized, because the question this slice answers is whether the pipeline
 * is general, not whether a workbook can be parsed. Parsing is the next slice
 * and it will land against this shape.
 *
 * NOTHING HERE IMPORTS `@dasher/station-domain`, and its absence from this
 * package's dependencies is asserted by a test rather than left to discipline.
 */

/**
 * AMOUNTS ARE DECIMAL TEXT, NOT `number`.
 *
 * They were `z.number()`, and the conversion into the calculation engine had to
 * read each one back through `toString` to recover the decimal the author wrote.
 * That was exact for a value a person types and it was a boundary rather than a
 * fix, said so at the time, and named this slice as where it lands: a workbook
 * carrying real cents has no reason to pass through a double on its way in.
 *
 * The grammar is the ordinary one rather than the canonical one, because a
 * spreadsheet writes `49875.00` and `-0` and refusing those would mean refusing
 * what exporters actually produce. `fromText` canonicalises on read.
 */
const DECIMAL_TEXT = z
  .string()
  .regex(/^-?\d+(?:\.\d+)?$/u, "amounts are decimal text, e.g. 49875 or 12.50")
  .max(40);

const LineSchema = z.strictObject({
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/u, "line ids are lowercase kebab-case"),
  label: z.string().min(1).max(120),
  /**
   * What this line is expected to cost in one period. Optional because a real
   * ledger has lines nobody budgeted, and a missing budget must read as "not
   * compared" rather than as a budget of zero.
   */
  budgetPerPeriod: DECIMAL_TEXT.optional(),
  amounts: z.array(DECIMAL_TEXT).min(2).max(240),
});

export const LedgerSnapshotSchema = z
  .strictObject({
    sourceName: z.string().min(1).max(120),
    sourceUrl: z.string().url().max(2048).optional(),
    retrievedAt: z.string().datetime({ offset: true }),
    /** ISO 4217. Carried because a number without one is not an amount. */
    currency: z.string().length(3),
    /** What one column is, in the reader's words: "month", "quarter". */
    periodLabel: z.string().min(1).max(32),
    /** `YYYY-MM`, oldest first. */
    periods: z
      .array(z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/u))
      .min(2)
      .max(240),
    lines: z.array(LineSchema).min(1).max(200),
  })
  .superRefine((snapshot, context) => {
    // A ragged table is the failure a normalized shape exists to exclude. It
    // would otherwise surface as a trend line that silently stops early.
    for (const [index, line] of snapshot.lines.entries()) {
      if (line.amounts.length !== snapshot.periods.length) {
        context.addIssue({
          code: "custom",
          path: ["lines", index, "amounts"],
          message: `line "${line.id}" has ${String(line.amounts.length)} amounts for ${String(snapshot.periods.length)} periods`,
        });
      }
    }
    /**
     * PERIODS MUST STRICTLY INCREASE, and until now only the comment said so.
     *
     * "`YYYY-MM`, oldest first" was the documented contract and nothing checked
     * it, which was survivable while every figure came from array positions. It
     * stopped being survivable when the calculation engine started ordering rows
     * by the period value: array order and sorted order can then disagree, and
     * they disagree silently. Measured on a snapshot whose periods ran newest
     * first, the dashboard named 2026-03 as the latest period and reported its
     * change as 0 — the engine had correctly found no earlier period to compare
     * against, while the reader was shown a line that had in fact fallen by 100.
     *
     * Strict increase is one rule covering both failures: a repeated period also
     * produces two rows with the same stable key, which the engine rejects as
     * `invalid_graph` — a closed code with nothing in it a reader could act on.
     */
    for (const [index, period] of snapshot.periods.entries()) {
      const earlier = snapshot.periods[index - 1];
      if (earlier !== undefined && earlier >= period) {
        context.addIssue({
          code: "custom",
          path: ["periods", index],
          message: `periods must run oldest first and appear once each; "${earlier}" is not before "${period}"`,
        });
      }
    }

    const ids = snapshot.lines.map((line) => line.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        path: ["lines"],
        message: "line ids must be unique",
      });
    }
  });

export type LedgerSnapshot = z.infer<typeof LedgerSnapshotSchema>;

/**
 * EVERY FIGURE HERE IS AN EXACT DECIMAL, NOT A `number`.
 *
 * These were all `number`, and the cost was visible in the repository before
 * anyone went looking for it: the committed fixture's shares summed to
 * 99.99999999999999, and the test written for that property asserted
 * `toBeCloseTo(100, 6)`. They are now computed by `@dasher/calculation-engine`,
 * which routes no value through a JavaScript number at all, and read out as
 * decimal text. `./exact` holds the comparison and formatting they need.
 */
export interface LedgerLineFacts {
  readonly id: string;
  readonly label: string;
  readonly latest: Exact;
  readonly previous: Exact;
  /** Absolute change over the last period. Negative means it fell. */
  readonly change: Exact;
  /** Percent change, or `null` when the previous period was zero. */
  readonly changePercent: Exact | null;
  /** Share of the latest period's total, as a percentage. */
  readonly share: Exact;
  readonly budgetPerPeriod: Exact | undefined;
  /** `undefined` when the line has no budget to be over. */
  readonly overBudgetBy: Exact | undefined;
  readonly evidenceId: string;
}

export interface LedgerFacts {
  readonly currency: string;
  readonly periodLabel: string;
  readonly periods: readonly string[];
  readonly latestPeriod: string;
  readonly previousPeriod: string;
  readonly lines: readonly LedgerLineFacts[];
  readonly total: Exact;
  readonly previousTotal: Exact;
  readonly totalChangePercent: Exact | null;
  /** Largest absolute movers, biggest first. */
  readonly movers: readonly LedgerLineFacts[];
  readonly overBudget: readonly LedgerLineFacts[];
  readonly evidence: readonly Evidence[];
  readonly lineEvidenceIds: readonly string[];
  readonly calculationEvidenceId: string;
  readonly retrievedAt: string;
}

export const LEDGER_CALCULATION_EVIDENCE_ID = "ledger-calculations";

/** `2026-03` → the instant the contract wants. Periods are whole months. */
export function periodStart(period: string): string {
  return `${period}-01T00:00:00.000Z`;
}

/**
 * Every number a ledger dashboard displays is computed here, from the snapshot,
 * exactly as station facts are. A plan chooses which lines and which sections;
 * it never supplies a value.
 *
 * NOTHING IN THIS FUNCTION DOES ARITHMETIC ON MONEY. Totals, changes, shares
 * and their percentages all come back from `calculateLedger`, which runs them
 * through the calculation engine on exact decimals. What is left here is
 * selection, ordering, and the one comparison the engine has no opinion about:
 * whether a line exceeded a budget the snapshot recorded.
 */
export function deriveLedgerFacts(snapshot: LedgerSnapshot): LedgerFacts {
  const parsed = LedgerSnapshotSchema.parse(snapshot);
  const last = parsed.periods.length - 1;
  const latestPeriod = parsed.periods[last] as string;
  const previousPeriod = parsed.periods[last - 1] as string;

  const calculated = calculateLedger(parsed);
  const at = new Map(
    calculated.cells.map((cell) => [
      `${cell.lineId}\u0000${cell.period}`,
      cell,
    ]),
  );
  const cellFor = (lineId: string, period: string): LedgerCellOf => {
    const found = at.get(`${lineId}\u0000${period}`);
    if (found === undefined) {
      throw new Error(
        `the calculation returned no ${period} row for ${lineId}`,
      );
    }
    return found;
  };

  const anchor = cellFor(parsed.lines[0]!.id, latestPeriod);
  const total = anchor.periodTotal;
  const previousTotal = cellFor(
    parsed.lines[0]!.id,
    previousPeriod,
  ).periodTotal;

  const lines: LedgerLineFacts[] = parsed.lines.map((line) => {
    const now = cellFor(line.id, latestPeriod);
    const budget =
      line.budgetPerPeriod === undefined
        ? undefined
        : fromText(line.budgetPerPeriod);
    // The one comparison left in JavaScript, and it is a comparison rather than
    // arithmetic on a computed value: both sides are exact, and `subtract` is
    // exact by construction.
    const over =
      budget !== undefined && compare(now.amount, budget) > 0
        ? subtract(now.amount, budget)
        : undefined;
    return {
      id: line.id,
      label: line.label,
      latest: now.amount,
      previous: cellFor(line.id, previousPeriod).amount,
      change: now.change ?? "0",
      changePercent: now.changePercent,
      // The engine returns a ratio; a share of nothing is not a share, and the
      // summary says the total instead rather than printing a fabricated zero
      // as though it were measured.
      share: now.share === null ? "0" : ratioToPercent(now.share),
      budgetPerPeriod: budget,
      overBudgetBy: over,
      evidenceId: `ledger-line-${line.id}`,
    };
  });

  const evidence: Evidence[] = [
    ...lines.map((line): Evidence => ({
      id: line.evidenceId,
      kind: "observed",
      label: `${line.label} amounts`,
      sourceName: parsed.sourceName,
      ...(parsed.sourceUrl === undefined
        ? {}
        : { sourceUrl: parsed.sourceUrl }),
      retrievedAt: parsed.retrievedAt,
      detail: `Recorded amounts for ${line.label} across ${String(parsed.periods.length)} ${parsed.periodLabel}s, ending ${parsed.periods[last]!}.`,
      confidence: "high",
    })),
    {
      id: LEDGER_CALCULATION_EVIDENCE_ID,
      kind: "calculated",
      label: "Ledger calculations",
      sourceName: "Dasher calculations",
      retrievedAt: parsed.retrievedAt,
      detail: `Totals, period-over-period change, share of total, and budget comparisons are computed by Dasher from the recorded amounts. Amounts are in ${parsed.currency}.`,
      confidence: "high",
    },
  ];

  return {
    currency: parsed.currency,
    periodLabel: parsed.periodLabel,
    periods: parsed.periods,
    latestPeriod,
    previousPeriod,
    lines,
    total,
    previousTotal,
    totalChangePercent: anchor.totalChangePercent,
    // Sorted by size of move, then by id so two equal moves order the same way
    // on every run rather than by whatever order the source happened to use.
    movers: [...lines].sort(
      (one, two) =>
        compare(abs(two.change), abs(one.change)) ||
        one.id.localeCompare(two.id),
    ),
    overBudget: lines
      .filter((line) => line.overBudgetBy !== undefined)
      .sort(
        (one, two) =>
          compare(two.overBudgetBy as Exact, one.overBudgetBy as Exact) ||
          one.id.localeCompare(two.id),
      ),
    evidence,
    lineEvidenceIds: lines.map((line) => line.evidenceId),
    calculationEvidenceId: LEDGER_CALCULATION_EVIDENCE_ID,
    retrievedAt: parsed.retrievedAt,
  };
}
