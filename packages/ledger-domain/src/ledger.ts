import type { Evidence } from "@dasher/dashboard-schema";
import { z } from "zod";

import {
  MAX_LEDGER_CELLS,
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

/**
 * Marks the one contract refusal that is about size rather than shape.
 *
 * A caller putting words to a refusal needs to tell "this file is not a ledger"
 * from "this ledger is bigger than Dasher can chart", and the two are otherwise
 * indistinguishable: both are custom issues on `lines`. Exported so the check
 * and the sentence cannot drift apart.
 */
export const LEDGER_TOO_LARGE = "ledgerTooLarge";

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
    /*
     * The ceiling the engine actually enforces, checked where a message can
     * still name it.
     *
     * `lines.max(200)` and `periods.max(240)` are independent, and their
     * product is two hundred times what `MAX_LEDGER_CELLS` allows — so the
     * contract promised sizes that failed later with `limit_exceeded`, reaching
     * a reader as "That export read correctly but no dashboard could be built
     * from it." A 30-line, 12-month export got that, with nothing to act on.
     */
    const cells = snapshot.lines.length * snapshot.periods.length;
    if (cells > MAX_LEDGER_CELLS) {
      context.addIssue({
        code: "custom",
        path: ["lines"],
        // Marked rather than identified by its path: the duplicate-id check
        // below raises a custom issue on the same path, and a caller that told
        // the two apart by position would report a size limit for a repeated
        // line id. The upload path reads this flag.
        params: { [LEDGER_TOO_LARGE]: true },
        message: `this export has ${String(snapshot.lines.length)} lines across ${String(snapshot.periods.length)} periods, which is ${String(cells)} figures; Dasher can build a dashboard from at most ${String(MAX_LEDGER_CELLS)}`,
      });
    }

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
  /**
   * Share of the latest period's total, as a percentage, or `null` when the
   * share column was refused.
   *
   * The null does NOT mean this period had no total — that reading was written
   * here first and it is wrong. `calculateLedger` drops a ratio for the whole
   * snapshot or not at all, so a share is absent when ANY period in the ledger
   * totals zero, including when the latest period's own total is large and
   * exact. A caller putting words to this must say the figure was not computed,
   * not why this row lacked a denominator.
   */
  readonly share: Exact | null;
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
      /*
       * A share of nothing is not a share of zero, and this used to say it was.
       * The comment that stood here claimed the summary reported the total
       * instead of "printing a fabricated zero as though it were measured" —
       * and the line under it printed exactly that fabricated zero. The null
       * travels now, and the compiler renders it in words.
       */
      share: now.share === null ? null : ratioToPercent(now.share),
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
      /*
       * Names what was actually computed for THIS ledger, not what this
       * function is capable of computing.
       *
       * The fixed string listed "share of total" unconditionally. On a ledger
       * whose shares were refused, that record was cited — at high confidence,
       * as supporting evidence — behind an em dash, so the audit trail asserted
       * a calculation that had not happened. The evidence panel is the one place
       * a reader goes to check a figure; it is the last place that should
       * describe work in general terms.
       */
      detail: `${["Totals", "period-over-period change", ...(lines.some((line) => line.share !== null) ? ["share of total"] : []), "budget comparisons"].join(", ").replace(/, ([^,]*)$/u, ", and $1")} are computed by Dasher from the recorded amounts.${lines.every((line) => line.share === null) ? " Share of total was not computed for this ledger, because a period in it totals zero." : ""} Amounts are in ${parsed.currency}.`,
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
