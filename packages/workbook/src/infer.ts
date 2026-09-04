/**
 * Typing the columns of a parsed file by what their cells actually hold.
 */

import type { CsvTable } from "./csv";
import {
  dateConvention,
  decimalConvention,
  detectCurrency,
  parseAmount,
  parseDate,
} from "./parse-values";
import type { ColumnProfile, ColumnType, DateConvention, Table } from "./table";

export interface ProfileOptions {
  /** Share of non-empty cells that must parse for a column to take a type. */
  readonly typeThreshold?: number;
  /**
   * The order to read `01/02/2026` in where a column's own cells never settle
   * it. `readTable` takes it from the delimiter; `profileTable` takes it from
   * the decimal mark the file writes. Defaults to `"month-first"`.
   */
  readonly dates?: DateConvention;
}

const DEFAULT_THRESHOLD = 0.8;
const SAMPLE_COUNT = 5;

/** Trims every cell and types every column; row text is otherwise untouched. */
export function profileTable(
  csv: CsvTable,
  options: ProfileOptions = {},
): Table {
  const rows = csv.rows.map((row) => row.map((cell) => cell.trim()));
  const cells = csv.headers.map((_, index) =>
    rows.map((row) => row[index] ?? ""),
  );
  /*
   * A comma decimal mark anywhere in the file says which locale wrote it, and
   * that locale writes the day first. A ledger stamped on the first of every
   * month holds no date that says so on its own, so this is the only evidence
   * there is that its months are not all January.
   */
  const european = cells.some(
    (column) => decimalConvention(column) === "comma",
  );
  const dates = options.dates ?? (european ? "day-first" : "month-first");
  const columns = csv.headers.map((name, index) =>
    profileColumn(name, index, cells[index] ?? [], { ...options, dates }),
  );
  return { columns, rows, rowCount: rows.length };
}

export function profileColumn(
  name: string,
  index: number,
  cells: readonly string[],
  options: ProfileOptions = {},
): ColumnProfile {
  const threshold = options.typeThreshold ?? DEFAULT_THRESHOLD;
  // Both conventions are the column's own: every cell is read the same way, so
  // the type a column takes and the values read from it cannot disagree.
  const decimal = decimalConvention(cells);
  const dates = dateConvention(cells, options.dates ?? "month-first");
  const distinct = new Set<string>();
  let nonEmpty = 0;
  let amounts = 0;
  let dated = 0;
  let currency: string | undefined;

  for (const cell of cells) {
    if (cell.length === 0) continue;
    nonEmpty += 1;
    distinct.add(cell);
    if (parseAmount(cell, { decimal }) !== null) {
      amounts += 1;
      currency ??= detectCurrency(cell);
    } else if (dates !== "mixed" && parseDate(cell, { dates }) !== null) {
      dated += 1;
    }
  }

  const type = decideType(nonEmpty, amounts, dated, threshold);
  const profile: ColumnProfile = {
    name,
    index,
    type,
    nonEmpty,
    distinct: distinct.size,
    samples: [...distinct].slice(0, SAMPLE_COUNT),
  };
  if (type === "number") {
    return currency === undefined
      ? { ...profile, decimal }
      : { ...profile, decimal, currency };
  }
  if (type === "date" && dates !== "mixed") return { ...profile, dates };
  return profile;
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
