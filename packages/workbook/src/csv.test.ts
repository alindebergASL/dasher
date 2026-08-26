import { describe, expect, it } from "vitest";

import { CSV_LIMITS, CsvRefused, columnIndexes, parseCsv } from "./csv";

/**
 * A delimited file is the first genuinely untrusted input this product reads.
 *
 * Every source before it was a committed fixture or a response from a named API
 * with a hand-written parser. A file has an author, and the author's tools are
 * Excel, Numbers, a database export, and a text editor on three operating
 * systems. So these are written against what those actually emit and against
 * what a malformed one does, rather than against a well-formed example.
 */

describe("the shapes real exporters produce", () => {
  it("reads the plain case", () => {
    expect(parseCsv("a,b\n1,2\n3,4\n")).toStrictEqual({
      headers: ["a", "b"],
      rows: [
        ["1", "2"],
        ["3", "4"],
      ],
    });
  });

  it("strips the byte-order mark Excel writes", () => {
    // Left in place it becomes part of the first header, so a mapping asking
    // for "a" stops matching a file that visibly has a column called "a".
    const table = parseCsv("﻿a,b\n1,2\n");

    expect(table.headers).toStrictEqual(["a", "b"]);
  });

  it("strips it before deciding whether the first header is quoted", () => {
    // The case that makes the stripping do any work. Trimming the header
    // already removes a leading mark, because U+FEFF is whitespace to `trim` —
    // so the test above passes with the stripping removed entirely, and both
    // mutants of that line survived it.
    //
    // A quoted first header is where it matters: with the mark still in front,
    // the opening quote is no longer the first character of the cell, so it is
    // read as a literal quote and the header keeps them.
    const table = parseCsv('﻿"line id","label"\n1,2\n');

    expect(table.headers).toStrictEqual(["line id", "label"]);
  });

  it("keeps a quote that is not the first character as a quote", () => {
    // A height in feet and inches, an initial in quotes, a stray one an
    // exporter did not escape. Only a quote opening a cell begins a quoted
    // cell; anywhere else
    // it is a character. Reading it as an opener swallows the rest of the file.
    expect(parseCsv('a,b\nx"y,2\n').rows).toStrictEqual([['x"y', "2"]]);
  });

  it("keeps a last row whose first cell is empty", () => {
    // A row of data and a blank line are both "a record", and only the second
    // is dropped. Told apart by the cell count, so an unbudgeted first column
    // does not make the row look like the end of the file.
    expect(parseCsv("a,b\n1,2\n,4\n").rows).toStrictEqual([
      ["1", "2"],
      ["", "4"],
    ]);
  });

  it.each([
    ["LF", "a,b\n1,2\n"],
    ["CRLF", "a,b\r\n1,2\r\n"],
    ["CR", "a,b\r1,2\r"],
    ["no trailing newline", "a,b\n1,2"],
  ])("reads %s line endings the same way", (_name, text) => {
    expect(parseCsv(text).rows).toStrictEqual([["1", "2"]]);
  });

  it("keeps a delimiter, a quote, and a newline inside a quoted cell", () => {
    const table = parseCsv('a,b\n"x,y","he said ""no"""\n');

    expect(table.rows[0]).toStrictEqual(["x,y", 'he said "no"']);
  });

  it("keeps a line break inside a quoted cell as the author wrote it", () => {
    // The record does not end here; a label spanning two lines is one label.
    const table = parseCsv('a,b\n"first\r\nsecond",2\n');

    expect(table.rows).toStrictEqual([["first\r\nsecond", "2"]]);
  });

  it("trims header whitespace but leaves cell values alone", () => {
    // A header is an identifier and " amount " is the same column as "amount".
    // A value is data: trimming it would silently change what was recorded.
    const table = parseCsv(" a , b \n 1 , 2 \n");

    expect(table.headers).toStrictEqual(["a", "b"]);
    expect(table.rows[0]).toStrictEqual([" 1 ", " 2 "]);
  });

  it("reads a semicolon file when told to", () => {
    // What a European Excel writes. The delimiter is a parameter rather than a
    // guess, because guessing it from the content is the first step towards
    // inferring meaning.
    expect(parseCsv("a;b\n1;2\n", CSV_LIMITS, ";").rows).toStrictEqual([
      ["1", "2"],
    ]);
  });
});

/**
 * Refusals, not repairs. This file cannot know what the author meant, and a
 * guess produces a dashboard that is confidently wrong rather than one that did
 * not build.
 */
describe("what it refuses", () => {
  const reasonOf = (text: string): string => {
    try {
      parseCsv(text);
      return "accepted";
    } catch (error) {
      return error instanceof CsvRefused ? error.reason : "other";
    }
  };

  it.each([
    // Padding invents a blank amount; dropping loses a budget line silently.
    ["ragged_row", "a,b\n1\n"],
    ["ragged_row", "a,b\n1,2,3\n"],
    // Everything after the opening quote became one cell.
    ["unclosed_quote", 'a,b\n"x,2\n'],
    // A mapping asking for the name gets whichever the implementation reaches.
    ["duplicate_header", "a,a\n1,2\n"],
    ["blank_header", "a,,b\n1,2,3\n"],
    ["empty", ""],
    ["empty", "\n\n"],
  ])("refuses with %s: %j", (reason, text) => {
    expect(reasonOf(text)).toBe(reason);
  });

  it("names the row a ragged record is on, counting from the file's first line", () => {
    expect(() => parseCsv("a,b\n1,2\n3\n")).toThrow(/row 3 has 1 cells/u);
  });

  it("refuses a file past each limit rather than working through it", () => {
    const tiny = { maxBytes: 20, maxRows: 2, maxColumns: 2, maxCellLength: 4 };

    expect(() => parseCsv("a,b\n" + "1,2\n".repeat(20), tiny)).toThrow(
      /too_large/u,
    );
    expect(() => parseCsv("a,b,c\n1,2,3\n", tiny)).toThrow(/too_many_columns/u);
    expect(() => parseCsv("a,b\n1,2\n1,2\n1,2\n", tiny)).toThrow(
      /too_many_rows/u,
    );
    expect(() => parseCsv("a,b\nlonger,2\n", tiny)).toThrow(/cell_too_long/u);
  });

  /**
   * Each limit at the value it states, which is the case a test written around
   * a limit never reaches: "past the limit is refused" holds just as well when
   * the limit is off by one, and every one of these four comparisons survived
   * being weakened from `>` to `>=`.
   *
   * The row limit was the one that mattered. A file of exactly `maxRows` rows
   * ending in the newline every editor writes was refused as having too many —
   * at the shipping limit, every ten-thousand-row export.
   */
  describe("a file that sits exactly on a limit is inside it", () => {
    // Only the row limit is tight here; the others are out of the way so that
    // a file testing the row count is not refused for its size first.
    const at = { ...CSV_LIMITS, maxRows: 2 };

    it.each([
      ["maxBytes", "a,b\n1,2\n", { ...CSV_LIMITS, maxBytes: 8 }],
      ["maxColumns", "a,b\n1,2\n", { ...CSV_LIMITS, maxColumns: 2 }],
      ["maxCellLength", "a,b\nabcd,2\n", { ...CSV_LIMITS, maxCellLength: 4 }],
      ["maxRows", "a,b\n1,2\n3,4\n", { ...CSV_LIMITS, maxRows: 2 }],
    ])("accepts a file exactly at %s", (_name, text, limits) => {
      expect(() => parseCsv(text, limits)).not.toThrow();
    });

    it.each([
      ["with the trailing newline every editor writes", "a,b\n1,2\n3,4\n"],
      ["without one", "a,b\n1,2\n3,4"],
      ["with several blank lines after it", "a,b\n1,2\n3,4\n\n\n\n"],
    ])("counts %s as two rows, not more", (_name, text) => {
      expect(parseCsv(text, at).rows).toStrictEqual([
        ["1", "2"],
        ["3", "4"],
      ]);
    });

    it("refuses the row after the limit", () => {
      expect(() => parseCsv("a,b\n1,2\n3,4\n5,6\n", at)).toThrow(
        /more than 2 rows/u,
      );
    });
  });

  /**
   * THE DEFECT THIS SECTION EXISTS FOR, STATED AS IT WAS MEASURED.
   *
   * The row guard was rewritten to discount trailing blank records, so that a
   * file of exactly `maxRows` rows ending in a newline stopped being refused.
   * It made the guard blind to the one input that most needs bounding:
   * `trailingBlanks` rises in lockstep with `records.length` across a RUN of
   * blank records, so their difference never moves and the limit never trips.
   *
   * Measured against the shipping limits before the fix, a 4 MB file of
   * newlines was ACCEPTED as zero rows after allocating 804 MB of heap and
   * blocking the event loop for 1.9 seconds. It is reachable from an upload,
   * which is a public endpoint.
   *
   * These cover it at a small limit, where the arithmetic is checkable, and the
   * one below covers it at a size where the old code actually hurt.
   */
  describe("a file of blank lines is bounded like any other", () => {
    const at = { ...CSV_LIMITS, maxRows: 2 };

    it("refuses a file that is nothing but newlines", () => {
      // Every record is blank, so the stated row limit never sees a row. The
      // record ceiling is what refuses it.
      expect(() => parseCsv("a\n" + "\n".repeat(500), at)).toThrow(
        /more than 2 rows/u,
      );
    });

    it("refuses blank lines that arrive after the data, past the allowance", () => {
      expect(() => parseCsv("a,b\n1,2\n" + "\n".repeat(500), at)).toThrow(
        /more than 2 rows/u,
      );
    });

    it("still accepts the handful of blank lines a real file ends with", () => {
      // The case the discount was introduced for, which must keep working: the
      // limit is about rows, and a trailing newline is not a row.
      expect(parseCsv("a,b\n1,2\n3,4\n\n\n\n", at).rows).toStrictEqual([
        ["1", "2"],
        ["3", "4"],
      ]);
    });

    it("draws the record ceiling where it says it does", () => {
      // The allowance is a stated policy — the row limit, plus the header, plus
      // sixteen blank records for the newlines a real file ends with. Written
      // out rather than computed from the constant, so that moving the constant
      // is a deliberate diff here too.
      //
      // A text of N newlines produces N + 1 records, and every record after the
      // header is blank, so `kept` stays at 1 and the ceiling is the only thing
      // deciding. With maxRows 2 the ceiling is 2 + 1 + 16 = 19 records.
      const withRecords = (count: number) => "a\n" + "\n".repeat(count - 2);

      expect(() => parseCsv(withRecords(19), at)).not.toThrow();
      expect(() => parseCsv(withRecords(20), at)).toThrow(/more than 2 rows/u);
    });

    it("holds a hostile file to a bounded number of records", () => {
      // The property, at the size that made it matter. Not a timing assertion —
      // those are flaky — but a bound on what the walk is allowed to build,
      // measured through the refusal it now produces instead of the array it
      // used to.
      const newlines = "a\n" + "\n".repeat(200_000);

      expect(() => parseCsv(newlines, CSV_LIMITS)).toThrow(/more than/u);
    });
  });

  /**
   * The detail beside the reason, which is the half a person can act on.
   *
   * Every one of these strings could be emptied without a test noticing. The
   * reason alone says a file was refused; the detail says which column, which
   * row, or which count, and an upload path has nothing else to show an author
   * who needs to go and fix their file.
   */
  it.each([
    [
      "too_large",
      "a,b\n€€€,2\n",
      { ...CSV_LIMITS, maxBytes: 12 },
      /1[0-9] bytes exceeds 12/u,
    ],
    [
      "too_many_columns",
      "a,b,c\n1,2,3\n",
      { ...CSV_LIMITS, maxColumns: 2 },
      /3 columns exceeds 2/u,
    ],
    [
      "cell_too_long",
      "a,b\nlonger,2\n",
      { ...CSV_LIMITS, maxCellLength: 4 },
      /6 characters exceeds 4/u,
    ],
    ["blank_header", "a,,b\n1,2,3\n", CSV_LIMITS, /column 2 has no name/u],
    ["duplicate_header", "a,a\n1,2\n", CSV_LIMITS, /"a" appears twice/u],
    ["empty", "", CSV_LIMITS, /holds no records/u],
    [
      "unclosed_quote",
      'a,b\n"x,2\n',
      CSV_LIMITS,
      /quoted cell is never closed/u,
    ],
  ])(
    "says what is wrong, not only that something is (%s)",
    (_reason, text, limits, detail) => {
      expect(() => parseCsv(text, limits)).toThrow(detail);
    },
  );

  it("names itself, so a refusal in a log says which one it was", () => {
    // `instanceof` is how code tells these apart and how every test above does
    // it, which leaves the class name checked by nothing — and the name is the
    // whole of what an operator reading a log line has to go on.
    const error = (() => {
      try {
        parseCsv("");
        return undefined;
      } catch (thrown) {
        return thrown as Error;
      }
    })();

    expect(String(error)).toBe(
      "CsvRefused: The file was refused (empty): the file holds no records",
    );
  });

  it("numbers a blank header from one, the way a spreadsheet does", () => {
    // Column 2, not column 1 and not column 3. An author reading this goes and
    // looks at a specific cell.
    expect(() => parseCsv(",b\n1,2\n")).toThrow(/column 1 has no name/u);
    expect(() => parseCsv("a,,b\n1,2,3\n")).toThrow(/column 2 has no name/u);
  });

  it("counts bytes rather than characters for the size limit", () => {
    // A file of multi-byte characters is larger on disk than its length
    // suggests, and the limit exists to bound memory rather than glyphs.
    const limits = { ...CSV_LIMITS, maxBytes: 12 };

    expect(() => parseCsv("a,b\n€€€,2\n", limits)).toThrow(/too_large/u);
  });
});

describe("columnIndexes", () => {
  const table = parseCsv("line_id,label,amount\nx,X,1\n");

  it("finds the columns a mapping declares, in the order it asked", () => {
    expect(columnIndexes(table, ["amount", "line_id"])).toStrictEqual([2, 0]);
  });

  it("names every column that is missing, not just the first", () => {
    expect(() =>
      columnIndexes(table, ["line_id", "period", "currency"]),
    ).toThrow(/"period", "currency"/u);
  });

  it("refuses it as a missing column, not as a blank header", () => {
    // Two different problems used to arrive under one reason. A file whose
    // columns are all perfectly well named was telling its author to go and
    // look for an unnamed one, and the reasons are a closed set precisely so
    // that the layer above can turn each into a sentence.
    try {
      columnIndexes(table, ["period"]);
      expect.unreachable("a missing column should be refused");
    } catch (error) {
      expect(error).toBeInstanceOf(CsvRefused);
      expect((error as CsvRefused).reason).toBe("missing_column");
    }
  });
});
