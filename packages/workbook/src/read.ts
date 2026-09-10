/**
 * The one call that takes uploaded text to a typed `Table`.
 */

import {
  CSV_LIMITS,
  CsvRefused,
  parseCsv,
  type CsvLimits,
  type CsvRefusal,
} from "./csv";
import { profileTable, type ProfileOptions } from "./infer";
import type { Table } from "./table";
import { readSpreadsheet } from "./xlsx";
import { unpivotIfWide, WideTableRefused } from "./unpivot";

export type TableRefusal =
  CsvRefusal | "no_rows" | "no_numeric_column" | "mixed_numeric_convention";

export class TableRefused extends Error {
  constructor(
    readonly reason: TableRefusal,
    readonly detail: string,
  ) {
    super(`The file was refused (${reason}): ${detail}`);
    this.name = "TableRefused";
  }
}

export interface ReadOptions extends ProfileOptions {
  /** Skips delimiter detection. */
  readonly delimiter?: string;
  readonly limits?: CsvLimits;
}

const DELIMITERS: readonly string[] = [",", ";", "\t", "|"];
const DETECTION_LINES = 10;

/** The delimiter that splits the first lines into the most, consistent, cells. */
export function detectDelimiter(text: string): string {
  const lines = text
    .split(/\r\n|\r|\n/u)
    .filter((line) => line.trim().length > 0)
    .slice(0, DETECTION_LINES);
  if (lines.length === 0) return ",";

  let best = ",";
  let bestScore = 0;
  for (const delimiter of DELIMITERS) {
    const counts = lines.map((line) => countOutsideQuotes(line, delimiter));
    const min = Math.min(...counts);
    const consistent = counts.every((count) => count === counts[0]);
    const score = min === 0 ? 0 : consistent ? min * 2 : min;
    if (score > bestScore) {
      best = delimiter;
      bestScore = score;
    }
  }
  return best;
}

function countOutsideQuotes(line: string, delimiter: string): number {
  let count = 0;
  let quoted = false;
  for (const character of line) {
    if (character === '"') quoted = !quoted;
    else if (!quoted && character === delimiter) count += 1;
  }
  return count;
}

/**
 * Everything that happens to a file once its rows exist: profiling, the checks
 * that refuse a table nothing can be computed from, and unpivoting a wide
 * export. A CSV and a spreadsheet share every line of it, which is the point —
 * a spreadsheet must not be able to take a shortcut past a rule a CSV obeys.
 */
export function tableFromRows(
  rows: {
    readonly headers: readonly string[];
    readonly rows: readonly (readonly string[])[];
  },
  profiling: ProfileOptions = {},
): Table {
  const table = profileTable(rows, profiling);
  if (table.rowCount === 0) {
    throw new TableRefused("no_rows", "the file has a header and no rows");
  }
  let shaped: Table;
  try {
    shaped = unpivotIfWide(table, profiling);
  } catch (error) {
    if (error instanceof WideTableRefused) {
      throw new TableRefused(error.reason, error.detail);
    }
    throw error;
  }
  if (!shaped.columns.some((column) => column.type === "number")) {
    throw new TableRefused(
      "no_numeric_column",
      "no column holds amounts to chart",
    );
  }
  return shaped;
}

/** Detects the delimiter, parses, profiles, and unpivots a wide file. */
export function readTable(csvText: string, options: ReadOptions = {}): Table {
  const delimiter = options.delimiter ?? detectDelimiter(csvText);
  /*
   * Excel writes a semicolon delimiter in exactly the locales whose decimal
   * mark is a comma and whose dates put the day first, so the delimiter is
   * evidence about the dates in the file.
   */
  const profiling: ProfileOptions = {
    ...options,
    dates: options.dates ?? (delimiter === ";" ? "day-first" : undefined),
  };
  let csv: {
    readonly headers: readonly string[];
    readonly rows: readonly (readonly string[])[];
  };
  try {
    csv = parseCsv(csvText, options.limits ?? CSV_LIMITS, delimiter);
  } catch (error) {
    if (error instanceof CsvRefused) {
      throw new TableRefused(error.reason, error.detail);
    }
    throw error;
  }
  return tableFromRows(csv, profiling);
}

/**
 * A spreadsheet's first usable sheet, as a Table.
 *
 * Cells arrive already resolved to text — a date serial as `2026-03-02`, an
 * amount as the characters the file stores — so from here on the file is
 * indistinguishable from a CSV and is treated as one. Dates are unambiguous by
 * then, so nothing has to guess at day-first or month-first.
 */
export function readSpreadsheetTable(
  bytes: Uint8Array,
  options: ReadOptions = {},
): { table: Table; sheetName: string; skipped: readonly string[] } {
  const book = readSpreadsheet(bytes);
  const [headers = [], ...rest] = book.rows;
  const width = book.rows.reduce(
    (widest, row) => Math.max(widest, row.length),
    0,
  );
  const square = (row: readonly string[]): string[] =>
    Array.from({ length: width }, (_, at) => row[at] ?? "");
  return {
    table: tableFromRows(
      { headers: square(headers), rows: rest.map(square) },
      { ...options, dates: options.dates ?? "month-first" },
    ),
    sheetName: book.sheetName,
    skipped: book.skipped,
  };
}
