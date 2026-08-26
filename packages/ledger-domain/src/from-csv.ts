import { CsvRefused, columnIndexes, parseCsv } from "@dasher/workbook";
import { z } from "zod";

import { LedgerSnapshotSchema, type LedgerSnapshot } from "./ledger";

/**
 * A ledger export, as a spreadsheet actually writes one, turned into a snapshot.
 *
 * WIDE, NOT LONG. A real ledger export puts budget lines down the page and
 * periods across it, because that is the shape a person reads. The normalized
 * form the calculation engine wants is the opposite — one row per line per
 * period — so this is where the pivot happens, and doing it here rather than in
 * the CSV reader keeps the reader a reader.
 *
 * WHY THE PROVENANCE IS A SIDECAR. A CSV carries cells and nothing else: no
 * source name, no retrieval time, no currency. Those are facts about where the
 * file came from, and inventing them from the filename would be a fabrication
 * written into the trusted layer. They travel beside the file, which is the
 * shape the UCR capture experiment already used.
 *
 * WHERE THIS SITS UNDER ADR-008. Every binding below is declared in this file
 * and deterministic: the three named columns, and the rule that a period column
 * is one whose header is `YYYY-MM`. Nothing proposes a meaning, so this is the
 * `parsed` tier and coordinate verification has nothing to check. It becomes
 * `extracted` — and needs all of ADR-008's machinery — the moment something
 * other than trusted code decides which column is the amount, because then that
 * decision picks which numbers reach the reader and no lexical check can tell a
 * right binding from a plausible wrong one. The spike measured that: zero of
 * seven semantic error classes caught.
 */

/** What a `YYYY-MM` column header looks like, and nothing else is a period. */
const PERIOD_HEADER = /^\d{4}-(?:0[1-9]|1[0-2])$/u;

const LINE_ID = "line_id";
const LABEL = "label";
const BUDGET = "budget_per_period";

/** Everything the file cannot say about itself. */
export const LedgerSourceSchema = z.strictObject({
  sourceName: z.string().min(1).max(120),
  sourceUrl: z.string().url().max(2048).optional(),
  retrievedAt: z.string().datetime({ offset: true }),
  currency: z.string().length(3),
  periodLabel: z.string().min(1).max(32),
});

export type LedgerSource = z.infer<typeof LedgerSourceSchema>;

/**
 * Reads a ledger CSV against a declared mapping.
 *
 * Refusals come back as `CsvRefused` from the reader and as a Zod error from
 * the snapshot contract, both of which name what was wrong. Nothing here
 * repairs a file: a blank budget cell means "no budget recorded", which the
 * snapshot already distinguishes from a budget of zero, but a blank amount is
 * a hole in the table and the contract refuses it rather than guessing.
 */
export function ledgerFromCsv(
  csv: string,
  source: LedgerSource,
): LedgerSnapshot {
  const table = parseCsv(csv);
  const [lineIdAt, labelAt, budgetAt] = columnIndexes(table, [
    LINE_ID,
    LABEL,
    BUDGET,
  ]) as [number, number, number];

  const periodColumns = table.headers
    .map((header, index) => ({ header, index }))
    .filter((column) => PERIOD_HEADER.test(column.header));

  if (periodColumns.length === 0) {
    throw new CsvRefused(
      "missing_column",
      "no column is named as a period, e.g. 2026-03",
    );
  }

  return LedgerSnapshotSchema.parse({
    ...source,
    // File order, not sorted. The snapshot contract requires periods to run
    // oldest first and refuses them otherwise, so a file whose columns are out
    // of order is reported as what it is rather than quietly reordered into
    // something the author did not write.
    periods: periodColumns.map((column) => column.header),
    lines: table.rows.map((row) => {
      const budget = (row[budgetAt] as string).trim();
      return {
        id: (row[lineIdAt] as string).trim(),
        label: (row[labelAt] as string).trim(),
        // An empty cell is "not budgeted", which the facts already read as "not
        // compared" rather than as a budget of zero.
        ...(budget === "" ? {} : { budgetPerPeriod: budget }),
        amounts: periodColumns.map((column) =>
          (row[column.index] as string).trim(),
        ),
      };
    }),
  });
}
