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
});
