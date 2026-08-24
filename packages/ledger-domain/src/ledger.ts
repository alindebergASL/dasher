// @ts-nocheck
import type { Evidence } from "@dasher/dashboard-schema";
import { z } from "zod";

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
  budgetPerPeriod: z.number().finite().nonnegative().optional(),
  amounts: z.array(z.number().finite()).min(2).max(240),
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

export interface LedgerLineFacts {
  readonly id: string;
  readonly label: string;
  readonly latest: number;
  readonly previous: number;
  /** Absolute change over the last period. Negative means it fell. */
  readonly change: number;
  /** Percent change, or `null` when the previous period was zero. */
  readonly changePercent: number | null;
  /** Share of the latest period's total, as a percentage. */
  readonly share: number;
  readonly budgetPerPeriod: number | undefined;
  /** `undefined` when the line has no budget to be over. */
  readonly overBudgetBy: number | undefined;
  readonly evidenceId: string;
}

export interface LedgerFacts {
  readonly currency: string;
  readonly periodLabel: string;
  readonly periods: readonly string[];
  readonly latestPeriod: string;
  readonly previousPeriod: string;
  readonly lines: readonly LedgerLineFacts[];
  readonly total: number;
  readonly previousTotal: number;
  readonly totalChangePercent: number | null;
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

function percentChange(latest: number, previous: number): number | null {
  return previous === 0 ? null : ((latest - previous) / previous) * 100;
}

/**
 * Every number a ledger dashboard displays is computed here, from the snapshot,
 * exactly as station facts are. A plan chooses which lines and which sections;
 * it never supplies a value.
 */
export function deriveLedgerFacts(snapshot: LedgerSnapshot): LedgerFacts {
  const parsed = LedgerSnapshotSchema.parse(snapshot);
  const last = parsed.periods.length - 1;
  const total = parsed.lines.reduce(
    (sum, line) => sum + line.amounts[last]!,
    0,
  );
  const previousTotal = parsed.lines.reduce(
    (sum, line) => sum + line.amounts[last - 1]!,
    0,
  );

  const lines: LedgerLineFacts[] = parsed.lines.map((line) => {
    const latest = line.amounts[last]!;
    const previous = line.amounts[last - 1]!;
    const over =
      line.budgetPerPeriod !== undefined && latest > line.budgetPerPeriod
        ? latest - line.budgetPerPeriod
        : undefined;
    return {
      id: line.id,
      label: line.label,
      latest,
      previous,
      change: latest - previous,
      changePercent: percentChange(latest, previous),
      // Zero total would make every share meaningless rather than zero, so it
      // is reported as zero share and the summary says the total instead.
      share: total === 0 ? 0 : (latest / total) * 100,
      budgetPerPeriod: line.budgetPerPeriod,
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
    latestPeriod: parsed.periods[last]!,
    previousPeriod: parsed.periods[last - 1]!,
    lines,
    total,
    previousTotal,
    totalChangePercent: percentChange(total, previousTotal),
    // Sorted by size of move, then by id so two equal moves order the same way
    // on every run rather than by whatever order the source happened to use.
    movers: [...lines].sort(
      (one, two) =>
        Math.abs(two.change) - Math.abs(one.change) ||
        one.id.localeCompare(two.id),
    ),
    overBudget: lines
      .filter((line) => line.overBudgetBy !== undefined)
      .sort(
        (one, two) =>
          two.overBudgetBy! - one.overBudgetBy! || one.id.localeCompare(two.id),
      ),
    evidence,
    lineEvidenceIds: lines.map((line) => line.evidenceId),
    calculationEvidenceId: LEDGER_CALCULATION_EVIDENCE_ID,
    retrievedAt: parsed.retrievedAt,
  };
}
