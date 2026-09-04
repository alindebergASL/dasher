/**
 * Typing the columns of a parsed file by what their cells actually hold.
 */

import type { CsvTable } from "./csv";
import { detectCurrency, parseAmount, parseDate } from "./parse-values";
import type { ColumnProfile, ColumnType, Table } from "./table";

export interface ProfileOptions {
  /** Share of non-empty cells that must parse for a column to take a type. */
  readonly typeThreshold?: number;
}

const DEFAULT_THRESHOLD = 0.8;
const SAMPLE_COUNT = 5;

/** Trims every cell and types every column; row text is otherwise untouched. */
export function profileTable(
  csv: CsvTable,
  options: ProfileOptions = {},
): Table {
  const threshold = options.typeThreshold ?? DEFAULT_THRESHOLD;
  const rows = csv.rows.map((row) => row.map((cell) => cell.trim()));
  const columns = csv.headers.map((name, index) =>
    profileColumn(
      name,
      index,
      rows.map((row) => row[index] ?? ""),
      threshold,
    ),
  );
  return { columns, rows, rowCount: rows.length };
}

export function profileColumn(
  name: string,
  index: number,
  cells: readonly string[],
  threshold = DEFAULT_THRESHOLD,
): ColumnProfile {
  const distinct = new Set<string>();
  let nonEmpty = 0;
  let amounts = 0;
  let dates = 0;
  let currency: string | undefined;

  for (const cell of cells) {
    if (cell.length === 0) continue;
    nonEmpty += 1;
    distinct.add(cell);
    if (parseAmount(cell) !== null) {
      amounts += 1;
      currency ??= detectCurrency(cell);
    } else if (parseDate(cell) !== null) {
      dates += 1;
    }
  }

  const type = decideType(nonEmpty, amounts, dates, threshold);
  const profile: ColumnProfile = {
    name,
    index,
    type,
    nonEmpty,
    distinct: distinct.size,
    samples: [...distinct].slice(0, SAMPLE_COUNT),
  };
  return type === "number" && currency !== undefined
    ? { ...profile, currency }
    : profile;
}

function decideType(
  nonEmpty: number,
  amounts: number,
  dates: number,
  threshold: number,
): ColumnType {
  if (nonEmpty === 0) return "text";
  if (amounts / nonEmpty >= threshold) return "number";
  if (dates / nonEmpty >= threshold) return "date";
  return "text";
}
