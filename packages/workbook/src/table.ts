/**
 * The one shape every uploaded file becomes before anything is planned or
 * computed. Cells stay as trimmed text; typed parsing happens where a value is
 * used, so nothing is lost or rounded between the file and a figure.
 */

export type ColumnType = "number" | "date" | "text";

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
