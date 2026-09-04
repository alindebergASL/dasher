/**
 * The one shape every uploaded file becomes before anything is planned or
 * computed. Cells stay as trimmed text; typed parsing happens where a value is
 * used, so nothing is lost or rounded between the file and a figure.
 */

export type ColumnType = "number" | "date" | "text";

/** Which separator a file uses as its decimal mark: `1,234.56` or `1.234,56`. */
export type DecimalConvention = "dot" | "comma";

/** Which component a file writes first in `01/02/2026`. */
export type DateConvention = "month-first" | "day-first";

export interface ColumnProfile {
  /** Header as written in the file, trimmed. Unique within a table. */
  readonly name: string;
  readonly index: number;
  /** Majority type of the non-empty cells; "text" when nothing else fits. */
  readonly type: ColumnType;
  readonly nonEmpty: number;
  readonly distinct: number;
  /** Up to five distinct raw values, in first-seen order. */
  readonly samples: readonly string[];
  /** Set on number columns when any cell carried a currency symbol. */
  readonly currency?: string;
  /**
   * Set on number columns: the convention every cell of the column is read
   * under. A caller re-parsing a cell must pass it, or `1.250` reads as `1.25`
   * in a file where the column means 1250.
   */
  readonly decimal?: DecimalConvention;
  /**
   * Set on date columns: the component order every cell of the column is read
   * under. A caller re-parsing a cell must pass it, or `01/02/2026` reads as
   * January in a column that means February.
   */
  readonly dates?: DateConvention;
}

export interface Table {
  readonly columns: readonly ColumnProfile[];
  /** Raw trimmed text, one entry per column, in column order. */
  readonly rows: readonly (readonly string[])[];
  readonly rowCount: number;
  /**
   * Present when the file was wide (one column per period) and was unpivoted
   * into one row per (line, period). The new columns are named `period` and
   * `amount`; a `budget` column is added when a budget-per-period column was
   * recognised.
   */
  readonly unpivoted?: {
    readonly periodColumns: readonly string[];
    readonly periodColumn: "period";
    readonly amountColumn: "amount";
    readonly budgetColumn?: "budget";
  };
}

export type Grain = "month" | "quarter" | "year";
