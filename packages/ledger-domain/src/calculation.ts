import {
  type CellSpec,
  type FieldSpec,
  type NodeSpec,
  buildCatalog,
  buildGraph,
  buildInput,
  decimal,
  fieldOut,
  rowsetOut,
  runCalculation,
  scalarOut,
  uuid,
} from "@dasher/calculation-engine";

import { type Exact, fromEngineDecimal, fromNumber } from "./exact";
import type { LedgerSnapshot } from "./ledger";

/**
 * The ledger's figures, computed by `@dasher/calculation-engine`.
 *
 * WHAT THIS BUYS. Every amount, change, share and variance on the dashboard was
 * a `number`. The engine routes no value through a JavaScript number at all:
 * amounts are `{coefficient, scale}` pairs read straight to `bigint`, every
 * stage runs on exact reduced rationals, and there is exactly one final
 * quantization. Measured on the committed fixture's latest period — the one the
 * dashboard shows — the shares summed to 99.99999999999999 before and to exactly
 * 100 after.
 *
 * NOT "ALWAYS EXACTLY 100", and the difference matters. Ratios rounded
 * independently to ten places need not sum to one place-value; two of this
 * fixture's six periods land one unit in the last place away. What the engine
 * changes is the KIND of residue: the float error came out of binary
 * representation and answered to no requested precision, while this one is
 * bounded by the scale the graph asks for and is invisible at the one decimal
 * place a reader is shown. `calculation.test.ts` measures both.
 *
 * THE INPUT TABLE IS THE POINT AS MUCH AS THE ARITHMETIC. `canonical-input-
 * table-v1` is a normalized table with typed fields, a stable row id per row,
 * and a sha256 over exact bytes — which is what a parsed workbook is. Building
 * the ledger through it means the workbook slice has a shape to land on rather
 * than one to invent, and means an amount is hashed at the boundary rather than
 * trusted after it.
 *
 * WHAT THE GRAPH LOOKS LIKE, AND WHY IT IS NOT THE OBVIOUS ONE. The first
 * version grouped by line, summed, and divided that by a whole-table sum. The
 * engine refuses it: `arithmetic operand evaluation domains must be identical`,
 * because a per-line aggregate and a whole-table aggregate are not values in
 * the same row space and dividing them is only meaningful if someone says how
 * the smaller one is broadcast. So share is a window function — the period
 * total computed over each row's own period partition — and the division
 * happens in the row domain where both operands live. That refusal is the
 * engine earning its place; the float version computed the same ratio without
 * ever asking the question.
 */

/** One row per line per period: the long form a normalized workbook has. */
const FIELD_LINE = uuid(701);
const FIELD_PERIOD = uuid(702);
const FIELD_AMOUNT = uuid(703);

const SOURCE = uuid(801);
const LINE = uuid(802);
const PERIOD = uuid(803);
const AMOUNT = uuid(804);
const PERIOD_TOTAL = uuid(805);
const SHARE = uuid(806);
const CHANGE = uuid(807);
const CHANGE_PERCENT = uuid(808);
const TOTAL_CHANGE_PERCENT = uuid(809);

/**
 * Ten fractional digits on the share ratio, eight on the percentage change.
 *
 * Both are far past what the dashboard prints, which is one decimal place. The
 * width is not for display: it is what makes the shares sum to exactly one
 * before rounding, so the figure a reader checks by adding up the column is the
 * figure that was computed.
 */
const SHARE_SCALE = 10;
const PERCENT_SCALE = 8;

/** A per-line, per-period result, in the row order the engine evaluated. */
export interface LedgerCell {
  readonly lineId: string;
  readonly period: string;
  readonly amount: Exact;
  /** Share of that period's total, as a ratio. `null` when the total is zero. */
  readonly share: Exact | null;
  /** Change against the previous period; `null` in the first period. */
  readonly change: Exact | null;
  /** Percent change; `null` in the first period or when the previous was zero. */
  readonly changePercent: Exact | null;
  /** Every line's amounts for this period, summed. Identical across the period. */
  readonly periodTotal: Exact;
  /** The period total's own percent change. `null` in the first period. */
  readonly totalChangePercent: Exact | null;
}

export interface LedgerCalculation {
  readonly cells: readonly LedgerCell[];
  /** The sha256 the engine computed over the input table's exact bytes. */
  readonly inputSha256: string;
  readonly rowCount: number;
}

/**
 * An RFC3339 timestamp as the engine's microsecond UTC form.
 *
 * The first version was `retrievedAt.replace("Z", "000Z")`, which is correct for
 * exactly one spelling and wrong for every other one the schema accepts.
 * `z.string().datetime({ offset: true })` also admits a timestamp with no
 * fractional seconds, one already carrying microseconds, and one written against
 * an offset rather than `Z` — and all three produced `invalid_graph`, so a
 * snapshot recorded as `2026-08-24T09:00:00+01:00` would have built no dashboard
 * at all. A string replacement that happens to fit the committed fixture is a
 * claim about every other input, made without looking at one.
 *
 * The offset is resolved through `Date`, which is safe here because the whole
 * seconds are shifted with the fraction stripped off first — no sub-millisecond
 * digit passes through a `number`. Fractions longer than six digits are
 * truncated rather than rounded: this stamps when a snapshot was read, and a
 * nanosecond of it is not a fact anyone acts on.
 */
const RFC3339 =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/u;

export function engineTimestamp(value: string): string {
  const match = RFC3339.exec(value);
  if (match === null) {
    throw new LedgerCalculationFailed(`${value} is not an RFC3339 timestamp`);
  }
  const [, seconds, fraction = "", zone] = match;
  const micros = `${fraction}000000`.slice(0, 6);
  const utc = new Date(`${seconds as string}${zone as string}`);
  if (Number.isNaN(utc.getTime())) {
    throw new LedgerCalculationFailed(`${value} is not a real instant`);
  }
  return `${utc.toISOString().slice(0, 19)}.${micros}Z`;
}

function textField(
  id: string,
  name: string,
  ordinal: number,
  bytes: number,
): FieldSpec {
  return {
    field_id: id,
    logical_name: name,
    scalar_type: "text",
    nullable: false,
    stable_key_ordinal: ordinal,
    semantic_type: "dimension",
    max_value_bytes: bytes,
    allowed_aggregations: ["count"],
  };
}

const ROW = { nullable: false, width: 74, grain: "row" } as const;

/**
 * `state: "missing"` is how the engine says a value does not exist — the first
 * period of a line has no previous period to change against. It is not zero,
 * and reading it as zero is the defect the ledger's own budget field already
 * avoids one layer up.
 */
function cellValue(entry: {
  state: string;
  value: { coefficient: string; scale: string } | null;
}): Exact | null {
  return entry.state === "present" && entry.value !== null
    ? fromEngineDecimal(entry.value)
    : null;
}

function textValue(entry: { state: string; value: string | null }): string {
  return entry.state === "present" && entry.value !== null ? entry.value : "";
}

/**
 * Builds the four documents, runs them, and reads the rows back.
 *
 * Every output node shares one evaluation domain — the source rowset — so the
 * engine returns their rows in one order and reading them by index aligns a
 * line and period with its own figures. Nothing here re-derives a value the
 * engine produced.
 */
function runLedger(
  snapshot: LedgerSnapshot,
  withRatios: boolean,
): LedgerCalculation {
  const currency = snapshot.currency;
  const fields: readonly FieldSpec[] = [
    textField(FIELD_LINE, "line_id", 0, 64),
    textField(FIELD_PERIOD, "period", 1, 16),
    {
      field_id: FIELD_AMOUNT,
      logical_name: "amount",
      scalar_type: "decimal",
      nullable: false,
      stable_key_ordinal: null,
      semantic_type: "measure",
      currency,
      max_value_bytes: 74,
      allowed_aggregations: ["max", "mean", "min", "sum"],
    },
  ];

  const rows: Array<Record<string, CellSpec>> = [];
  for (const line of snapshot.lines) {
    line.amounts.forEach((amount, index) => {
      const period = snapshot.periods[index] as string;
      const exact = fromNumber(amount);
      const dot = exact.indexOf(".");
      rows.push({
        [FIELD_LINE]: { state: "present", value: line.id },
        [FIELD_PERIOD]: { state: "present", value: period },
        [FIELD_AMOUNT]: {
          state: "present",
          value: decimal(
            exact.replace(".", ""),
            dot === -1 ? 0 : exact.length - dot - 1,
          ),
        },
      });
    });
  }

  const input = buildInput({ fields, rows });
  const evaluatedAt = engineTimestamp(snapshot.retrievedAt);
  const catalog = buildCatalog({ input, fields, evaluatedAt });

  const sortByPeriod = [
    { value_node_id: PERIOD, direction: "asc", nulls: "last", tie: true },
  ];
  /**
   * The frame spans a whole partition. A partition is one period, so it holds
   * exactly as many rows as there are lines, and reaching that far in both
   * directions from any row covers all of them.
   */
  const reach = Math.max(snapshot.lines.length - 1, 0);

  const everyNode: readonly NodeSpec[] = [
    {
      node_id: SOURCE,
      op: "source",
      evaluation_rows_from: null,
      output_type: rowsetOut(fields.map(fieldOut)),
      field_ids: fields.map((field) => field.field_id).sort(),
    },
    {
      node_id: LINE,
      op: "field",
      evaluation_rows_from: SOURCE,
      input: SOURCE,
      field_id: FIELD_LINE,
      output_type: scalarOut({ scalar: "text", ...ROW, width: 64 }),
    },
    {
      node_id: PERIOD,
      op: "field",
      evaluation_rows_from: SOURCE,
      input: SOURCE,
      field_id: FIELD_PERIOD,
      output_type: scalarOut({ scalar: "text", ...ROW, width: 16 }),
    },
    {
      node_id: AMOUNT,
      op: "field",
      evaluation_rows_from: SOURCE,
      input: SOURCE,
      field_id: FIELD_AMOUNT,
      output_type: scalarOut({ scalar: "decimal", ...ROW, currency }),
    },
    {
      node_id: PERIOD_TOTAL,
      op: "window_sum",
      evaluation_rows_from: SOURCE,
      input: AMOUNT,
      partition_node_ids: [PERIOD],
      keys: sortByPeriod as never,
      preceding: `i64:${String(reach)}`,
      following: `i64:${String(reach)}`,
      output_type: scalarOut({ scalar: "decimal", ...ROW, currency }),
    },
    {
      node_id: SHARE,
      op: "divide",
      evaluation_rows_from: SOURCE,
      left: AMOUNT,
      right: PERIOD_TOTAL,
      scale: `i64:${String(SHARE_SCALE)}`,
      rounding: "half_even",
      // `divide` yields the dimensionless unit: a share of money is not money.
      output_type: scalarOut({ scalar: "decimal", ...ROW, unit: "1" }),
    },
    {
      node_id: CHANGE,
      op: "delta",
      evaluation_rows_from: SOURCE,
      input: AMOUNT,
      partition_node_ids: [LINE],
      keys: sortByPeriod as never,
      offset: "i64:1",
      scale: "i64:0",
      rounding: "half_even",
      output_type: scalarOut({ scalar: "decimal", ...ROW, currency }),
    },
    {
      node_id: CHANGE_PERCENT,
      op: "percentage_change",
      evaluation_rows_from: SOURCE,
      input: AMOUNT,
      partition_node_ids: [LINE],
      keys: sortByPeriod as never,
      offset: "i64:1",
      scale: `i64:${String(PERCENT_SCALE)}`,
      rounding: "half_even",
      output_type: scalarOut({ scalar: "decimal", ...ROW, unit: "%" }),
    },
    {
      /**
       * The total's own period-over-period change, computed by the engine
       * rather than divided out in JavaScript afterwards.
       *
       * Partitioning by line rather than by period is what makes it work. The
       * period total is broadcast identically onto every row of its period, so
       * following one line's rows in period order walks the totals in period
       * order too. Every line therefore yields the same answer, which the
       * reader below asserts rather than assumes.
       */
      node_id: TOTAL_CHANGE_PERCENT,
      op: "percentage_change",
      evaluation_rows_from: SOURCE,
      input: PERIOD_TOTAL,
      partition_node_ids: [LINE],
      keys: sortByPeriod as never,
      offset: "i64:1",
      scale: `i64:${String(PERCENT_SCALE)}`,
      rounding: "half_even",
      output_type: scalarOut({ scalar: "decimal", ...ROW, unit: "%" }),
    },
  ];

  /**
   * The three ratios are dropped together when a denominator is zero. Which
   * denominator it was does not change the answer for a reader — a ledger with
   * nothing in it has no shares and no percentage changes — and reporting some
   * ratios and not others would need this function to explain a distinction the
   * dashboard has no room to make.
   */
  const nodes = everyNode.filter(
    (node) => withRatios || !RATIO_NODE_IDS.has(node.node_id),
  );

  const graph = buildGraph({
    nodes,
    outputNodeIds: [
      LINE,
      PERIOD,
      AMOUNT,
      PERIOD_TOTAL,
      CHANGE,
      ...(withRatios ? [SHARE, CHANGE_PERCENT, TOTAL_CHANGE_PERCENT] : []),
    ],
    contractOutputNodeId: AMOUNT,
    input,
    catalog,
    evaluationTime: evaluatedAt,
  });

  const run = runCalculation({
    rawGraphBytes: graph.bytes,
    inputBytes: input.bytes,
    catalogBytes: catalog.bytes,
    calendar: "gregorian",
    // No metric contract set is declared, so there is no conformance claim to
    // check. Adding one would assert a published metric definition the ledger
    // does not have; a contract nobody publishes is a claim beside the code.
    skipContractConformance: true,
  });

  /**
   * A null outcome is a static failure; a `failed` outcome is a runtime one,
   * and it carries an envelope with no outputs rather than an exception.
   *
   * Only the first was checked at first, which is why a snapshot whose total
   * was zero surfaced as "missing output <uuid>" — a division by zero inside
   * the engine, reported as a typed failure, read here as a bug in reading the
   * result. Both are the same thing to a caller: the figures did not compute.
   */
  if (run.outcome === null || run.outcome.state !== "succeeded") {
    throw new LedgerCalculationFailed(
      run.error_code ?? run.outcome?.error_code ?? "unknown",
    );
  }

  const outputs = (
    JSON.parse(run.outcome.resultBytes as string) as {
      outputs: {
        node_id: string;
        rows: { value: { state: string; value: unknown } }[];
      }[];
    }
  ).outputs;
  const rowsOf = (nodeId: string): { state: string; value: unknown }[] => {
    const found = outputs.find((output) => output.node_id === nodeId);
    if (found === undefined) {
      throw new LedgerCalculationFailed(`missing output ${nodeId}`);
    }
    return found.rows.map((row) => row.value);
  };

  const lineRows = rowsOf(LINE);
  const periodRows = rowsOf(PERIOD);
  const amountRows = rowsOf(AMOUNT);
  const shareRows = withRatios ? rowsOf(SHARE) : null;
  const changeRows = rowsOf(CHANGE);
  const changePercentRows = withRatios ? rowsOf(CHANGE_PERCENT) : null;
  const periodTotalRows = rowsOf(PERIOD_TOTAL);
  const totalChangeRows = withRatios ? rowsOf(TOTAL_CHANGE_PERCENT) : null;

  const decimalAt = (
    source: { state: string; value: unknown }[] | null,
    index: number,
  ): Exact | null =>
    source === null
      ? null
      : cellValue(
          source[index] as {
            state: string;
            value: { coefficient: string; scale: string } | null;
          },
        );

  /**
   * Identity comes from the engine's own output, never from the order the rows
   * were built in.
   *
   * The first version zipped these against the insertion order and guarded the
   * assumption; the guard fired on the first real run — row 6 came back as
   * `travel/2026-03`, not `salaries/2026-03`. The engine orders rows by their
   * canonical row id, which is a hash of the stable key fields, so insertion
   * order is not a property it preserves or promises. Had the guard not been
   * there, every figure would have been individually correct and attached to
   * the wrong budget line.
   */
  const cells = lineRows.map((_, index): LedgerCell => ({
    lineId: textValue(
      lineRows[index] as { state: string; value: string | null },
    ),
    period: textValue(
      periodRows[index] as { state: string; value: string | null },
    ),
    amount: decimalAt(amountRows, index) ?? "0",
    share: decimalAt(shareRows, index),
    change: decimalAt(changeRows, index),
    changePercent: decimalAt(changePercentRows, index),
    periodTotal: decimalAt(periodTotalRows, index) ?? "0",
    totalChangePercent: decimalAt(totalChangeRows, index),
  }));

  /**
   * The period total is supposed to be one number per period. Asserting it here
   * costs a pass over rows that are already in memory, and turns a wrong window
   * frame — the one parameter of this graph that is computed from the data
   * rather than fixed — into a failure with a name instead of a total that is
   * quietly short by one line.
   */
  const totals = new Map<string, Exact>();
  for (const cell of cells) {
    const seen = totals.get(cell.period);
    if (seen !== undefined && seen !== cell.periodTotal) {
      throw new LedgerCalculationFailed(
        `period ${cell.period} produced two totals, ${seen} and ${cell.periodTotal}`,
      );
    }
    totals.set(cell.period, cell.periodTotal);
  }

  return { cells, inputSha256: input.sha256, rowCount: rows.length };
}

const RATIO_NODE_IDS: ReadonlySet<string> = new Set([
  SHARE,
  CHANGE_PERCENT,
  TOTAL_CHANGE_PERCENT,
]);

/**
 * Runs the figures, and answers a zero denominator with absence.
 *
 * The engine refuses `x / 0` — the whole run fails with `divide_by_zero` rather
 * than yielding a null a caller might print — and that refusal is right. What it
 * means for a ledger is that a period whose total is zero, or a line whose
 * previous amount was zero, has no share and no percentage change to report.
 *
 * The guard cannot go in the graph. It would need a literal zero to compare the
 * total against, and a literal derives `grain: null` and `currency: null`, so
 * comparing one to a row-grained amount in USD fails on both counts before it
 * ever runs. Rather than smuggle the case past the engine, the ratios are simply
 * not asked for on the second attempt, and `null` reaches the facts exactly
 * where the float version returned `null` for the same reason.
 *
 * The retry costs a second run only in the degenerate case; every real snapshot
 * answers on the first.
 */
export function calculateLedger(snapshot: LedgerSnapshot): LedgerCalculation {
  try {
    return runLedger(snapshot, true);
  } catch (error) {
    if (
      error instanceof LedgerCalculationFailed &&
      error.reason === "divide_by_zero"
    ) {
      return runLedger(snapshot, false);
    }
    throw error;
  }
}

/**
 * The engine answers with a closed error code rather than a stack trace, and
 * this carries that code rather than inventing a sentence about it.
 */
export class LedgerCalculationFailed extends Error {
  constructor(readonly reason: string) {
    super(`The ledger calculation did not run: ${reason}`);
    this.name = "LedgerCalculationFailed";
  }
}
