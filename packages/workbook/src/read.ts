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
import { unpivotIfWide } from "./unpivot";

export type TableRefusal = CsvRefusal | "no_rows" | "no_numeric_column";

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

/** Detects the delimiter, parses, profiles, and unpivots a wide file. */
export function readTable(csvText: string, options: ReadOptions = {}): Table {
  const delimiter = options.delimiter ?? detectDelimiter(csvText);
  let table: Table;
  try {
    const csv = parseCsv(csvText, options.limits ?? CSV_LIMITS, delimiter);
    table = profileTable(csv, options);
  } catch (error) {
    if (error instanceof CsvRefused) {
      throw new TableRefused(error.reason, error.detail);
    }
    throw error;
  }
  if (table.rowCount === 0) {
    throw new TableRefused("no_rows", "the file has a header and no rows");
  }
  const shaped = unpivotIfWide(table);
  if (!shaped.columns.some((column) => column.type === "number")) {
    throw new TableRefused(
      "no_numeric_column",
      "no column holds amounts to chart",
    );
  }
  return shaped;
}
