/**
 * Reading a delimited file into a rectangular table, deterministically.
 *
 * WHERE THIS SITS IN THE PROVENANCE MODEL. ADR-008 divides how a number reaches
 * a dashboard: `parsed`, where trusted code reads a structured source, and
 * `extracted`, where a model proposes that some characters in a document denote
 * a value and trusted code verifies that at coordinates. Its Context paragraph
 * names the first category exactly — "a hand-written parser over a structured
 * source" — and lists USGS, OpenAQ and the UCR capture as its members.
 *
 * THIS IS THAT CATEGORY. Nothing here proposes a meaning. It splits characters
 * on delimiters under a fixed grammar and hands back the cells it found, and
 * every decision it makes is one a reader of this file can check.
 *
 * THE LINE, SO THAT CROSSING IT IS DELIBERATE. It becomes extraction the moment
 * a model decides which row is the header, which column holds an amount, or
 * which of several tables on a sheet is the one meant — because then the model's
 * answer decides which numbers reach the page, and that binding is semantically
 * unverified. The measured finding of the ADR-008 spike is that a lexical
 * checker catches none of the seven semantic error classes, zero of seven. Keep
 * the mapping declared and deterministic and none of that machinery is needed;
 * make it a model's judgement and all of it is.
 */

/** What a reader is allowed to hand over, so a hostile file cannot exhaust us. */
export interface CsvLimits {
  readonly maxBytes: number;
  readonly maxRows: number;
  readonly maxColumns: number;
  /** Longest single cell, in characters. */
  readonly maxCellLength: number;
}

export const CSV_LIMITS: CsvLimits = {
  // A ledger export of a few hundred lines over twenty years of months is
  // comfortably inside this; a file that is not is a different product.
  maxBytes: 4 * 1024 * 1024,
  maxRows: 10_000,
  maxColumns: 512,
  maxCellLength: 4096,
};

export type CsvRefusal =
  | "too_large"
  | "too_many_rows"
  | "too_many_columns"
  | "cell_too_long"
  | "unclosed_quote"
  | "ragged_row"
  | "empty"
  | "duplicate_header"
  | "blank_header"
  /**
   * A column the caller's mapping named is not in the file.
   *
   * Distinct from `blank_header`, which is a column in the file with no name.
   * Both used to report `blank_header`, so a file whose columns are all
   * perfectly well named told its author to go looking for an unnamed one. The
   * reasons are a closed set precisely so that the layer above can turn each
   * into a sentence, and two different problems sharing one reason means one of
   * those sentences is wrong.
   */
  | "missing_column";

export class CsvRefused extends Error {
  constructor(
    readonly reason: CsvRefusal,
    detail: string,
  ) {
    super(`The file was refused (${reason}): ${detail}`);
    this.name = "CsvRefused";
  }
}

export interface Table {
  /** Column names, in file order, trimmed. */
  readonly headers: readonly string[];
  /** One entry per data row, each the same length as `headers`. */
  readonly rows: readonly (readonly string[])[];
}

/**
 * A byte-order mark is metadata, not content.
 *
 * Excel writes one on every CSV it exports. Left in place it becomes part of the
 * first header name, so a column called `line_id` silently stops matching a
 * mapping that asks for `line_id` — a failure that reads as "the file is wrong"
 * when the file is the one a spreadsheet actually produces.
 */
const BYTE_ORDER_MARK = "﻿";

/**
 * Refusals, not repairs, and the reason is uniform: this file cannot know what
 * the author meant, and guessing produces a dashboard that is confidently wrong
 * rather than one that did not build. A ragged row might be a missing trailing
 * comma or a stray delimiter inside an unquoted cell; padding it invents a blank
 * amount, and dropping it loses a budget line without saying so.
 */
export function parseCsv(
  text: string,
  limits: CsvLimits = CSV_LIMITS,
  delimiter = ",",
): Table {
  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes > limits.maxBytes) {
    throw new CsvRefused(
      "too_large",
      `${String(bytes)} bytes exceeds ${String(limits.maxBytes)}`,
    );
  }

  const body = text.startsWith(BYTE_ORDER_MARK) ? text.slice(1) : text;
  const records = splitRecords(body, delimiter, limits);

  // A trailing newline is how every text editor ends a file; the empty record
  // it produces is not a row of data.
  while (
    records.length > 0 &&
    isBlank(records[records.length - 1] as string[])
  ) {
    records.pop();
  }
  if (records.length === 0) {
    throw new CsvRefused("empty", "the file holds no records");
  }

  const headers = (records[0] as string[]).map((cell) => cell.trim());
  if (headers.length > limits.maxColumns) {
    throw new CsvRefused(
      "too_many_columns",
      `${String(headers.length)} columns exceeds ${String(limits.maxColumns)}`,
    );
  }
  for (const [index, header] of headers.entries()) {
    if (header.length === 0) {
      throw new CsvRefused(
        "blank_header",
        `column ${String(index + 1)} has no name`,
      );
    }
  }
  // Two columns with one name means a mapping that asks for it gets whichever
  // the implementation happens to reach first, which is not a decision anyone
  // made.
  const seen = new Set<string>();
  for (const header of headers) {
    if (seen.has(header)) {
      throw new CsvRefused("duplicate_header", `"${header}" appears twice`);
    }
    seen.add(header);
  }

  // No row-count check here. `splitRecords` applies it while walking, because
  // by this point the whole file is already an array of arrays and refusing it
  // then would be refusing something we have finished building. A check here as
  // well was unreachable — the walk cannot hand back more rows than it allows —
  // and the mutation run reported it as covered by nothing, which is how it was
  // found.
  const rows = records.slice(1);
  for (const [index, row] of rows.entries()) {
    if (row.length !== headers.length) {
      throw new CsvRefused(
        "ragged_row",
        `row ${String(index + 2)} has ${String(row.length)} cells for ${String(headers.length)} columns`,
      );
    }
  }

  return { headers, rows };
}

function isBlank(record: readonly string[]): boolean {
  return record.length === 1 && record[0] === "";
}

/**
 * How many records the walk may hold, blank ones included.
 *
 * The row limit alone cannot bound this, because blank records are excluded
 * from it by design — see `endRecord`. So this is the row limit plus an
 * allowance for the blank records a real file ends with, which is one for a
 * trailing newline and a handful for a file somebody left blank lines at the
 * end of. Sixteen is far more than any exporter writes and still holds the
 * walk to `maxRows + 17` records.
 *
 * A file that exceeds it is refused as having too many rows, and for a file of
 * blank lines that is the honest answer: a blank line is a record, and a
 * million of them is a million records whatever they contain.
 */
const BLANK_RECORD_ALLOWANCE = 16;

function recordCeiling(limits: CsvLimits): number {
  return limits.maxRows + 1 + BLANK_RECORD_ALLOWANCE;
}

/**
 * The RFC 4180 grammar, walked one character at a time.
 *
 * A regular expression cannot express it: a quoted cell may contain the
 * delimiter, a newline, and a doubled quote standing for one quote, and telling
 * those apart needs the state of whether we are inside quotes. Line endings are
 * normalised here rather than up front, so a CRLF inside a quoted cell survives
 * as the author wrote it while one between records ends the record.
 */
function splitRecords(
  text: string,
  delimiter: string,
  limits: CsvLimits,
): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let cell = "";
  let quoted = false;
  let index = 0;
  /**
   * Blank records pushed since the last one that held anything.
   *
   * `parseCsv` drops these from the end before counting rows, so counting them
   * against the row limit refuses files that are within it. `maxRows` data rows
   * written with the trailing newline that every editor and exporter adds
   * produced `maxRows + 2` records — header, rows, and the empty record after
   * the last newline — and was refused as too many rows. At the shipping limit
   * that is every ten-thousand-row export.
   */
  let trailingBlanks = 0;

  const endCell = (): void => {
    if (cell.length > limits.maxCellLength) {
      throw new CsvRefused(
        "cell_too_long",
        `a cell of ${String(cell.length)} characters exceeds ${String(limits.maxCellLength)}`,
      );
    }
    record.push(cell);
    cell = "";
  };
  const endRecord = (): void => {
    endCell();
    records.push(record);
    trailingBlanks = isBlank(record) ? trailingBlanks + 1 : 0;
    record = [];

    /*
     * TWO BOUNDS, AND EACH EXISTS BECAUSE THE OTHER DOES NOT COVER IT.
     *
     * `kept` is the row limit as stated: records that will still be here after
     * `parseCsv` drops the trailing blanks. It is the one a reader's file is
     * judged by.
     *
     * `records.length` is the memory bound, and leaving it out was a defect in
     * this file's own history worth stating plainly. `trailingBlanks` rises in
     * lockstep with `records.length` across a RUN of blank records, so their
     * difference never moves — which means a file that is nothing but newlines
     * never trips `kept` at all. Measured on the shipping limits before this
     * line existed: a 4 MB file of newlines was ACCEPTED as zero rows after
     * allocating 804 MB of heap and blocking the event loop for 1.9 seconds.
     * The text is bounded by `maxBytes`, but one byte of it becomes an array
     * holding a string, and that amplification is what this stops.
     */
    const kept = records.length - trailingBlanks;
    if (kept > limits.maxRows + 1 || records.length > recordCeiling(limits)) {
      // Deliberately not a count. Refusing mid-walk means the true total is not
      // known yet — the previous wording computed one from `kept` and was
      // therefore always `maxRows + 1`, telling a fifty-thousand-row export it
      // had ten thousand and one.
      throw new CsvRefused(
        "too_many_rows",
        `more than ${String(limits.maxRows)} rows`,
      );
    }
  };

  while (index < text.length) {
    const character = text[index] as string;
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }
      cell += character;
      index += 1;
      continue;
    }
    if (character === '"' && cell.length === 0) {
      quoted = true;
      index += 1;
      continue;
    }
    if (character === delimiter) {
      endCell();
      index += 1;
      continue;
    }
    if (character === "\r") {
      // A lone CR is a classic Mac line ending, and CRLF is what Windows and
      // Excel write. Both end the record; only the pair consumes two characters.
      endRecord();
      index += text[index + 1] === "\n" ? 2 : 1;
      continue;
    }
    if (character === "\n") {
      endRecord();
      index += 1;
      continue;
    }
    cell += character;
    index += 1;
  }

  if (quoted) {
    // Everything after the opening quote was swallowed into one cell. Accepting
    // it would turn the rest of the file into a single value.
    throw new CsvRefused("unclosed_quote", "a quoted cell is never closed");
  }
  endRecord();
  return records;
}

/** The column indexes a mapping asked for, or a refusal naming what is absent. */
export function columnIndexes(
  table: Table,
  wanted: readonly string[],
): readonly number[] {
  const missing = wanted.filter((name) => !table.headers.includes(name));
  if (missing.length > 0) {
    throw new CsvRefused(
      "missing_column",
      `the file has no column named ${missing.map((name) => `"${name}"`).join(", ")}`,
    );
  }
  return wanted.map((name) => table.headers.indexOf(name));
}
