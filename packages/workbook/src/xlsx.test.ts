import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  columnOf,
  looksLikeDateFormat,
  readSpreadsheet,
  serialToIsoDate,
  SpreadsheetError,
} from "./xlsx";

const FIXTURES = path.resolve(process.cwd(), "..", "..", "fixtures", "xlsx");

function open(file: string) {
  return readSpreadsheet(
    new Uint8Array(readFileSync(path.join(FIXTURES, file))),
  );
}

/**
 * Every fixture here was written by Python's openpyxl, so these check the
 * reader against files a real spreadsheet writer produced rather than against
 * XML this repository invented.
 */
describe("reading a spreadsheet a real writer produced", () => {
  it("reads dates, text and amounts off the sheet", () => {
    const book = open("transactions.xlsx");
    expect(book.sheetName).toBe("Transactions");
    expect(book.rows[0]).toEqual(["Date", "Category", "Amount"]);
    expect(book.rows[1]).toEqual(["2026-03-02", "Cloud", "1234.56"]);
    expect(book.rows[2]).toEqual(["2026-03-17", "Travel", "890.1"]);
    expect(book.rows).toHaveLength(11);
  });

  it("carries an amount through as the characters the file holds", () => {
    // Not 1234.5600000000001: the stored decimal string is never parsed and
    // re-printed, which is where exactness is lost.
    const amounts = open("transactions.xlsx")
      .rows.slice(1)
      .map((row) => row[2]);
    expect(amounts).toEqual([
      "1234.56",
      "890.1",
      "1301.44",
      "712.05",
      "1288.9",
      "9000",
      "1350.75",
      "655.2",
      "1402.11",
      "9250",
    ]);
    expect(amounts.some((value) => value?.includes("e"))).toBe(false);
    expect(amounts.every((value) => (value?.length ?? 0) <= 8)).toBe(true);
  });

  it("carries values a float round-trip would change, unchanged", () => {
    // Each of these differs after Number(x) and back: trailing zeros a currency
    // format keeps, an integer past 2^53 that rounds to an even neighbour, and
    // a small value that turns into exponent notation. A spreadsheet holding
    // 9007199254740993 must not report 9007199254740992.
    const amounts = open("exact-amounts.xlsx")
      .rows.slice(1)
      .map((row) => row[2]);
    expect(amounts).toEqual([
      "1.10",
      "2.50",
      "9007199254740993",
      "0.00000001",
      "1234567890.12345",
    ]);
  });

  it("passes over a cover sheet to the one holding the table", () => {
    const book = open("cover-sheet-first.xlsx");
    expect(book.sheetName).toBe("Q3 detail");
    expect(book.skipped).toEqual(["Read me"]);
    expect(book.rows[0]).toEqual(["Date", "Team", "Hours"]);
    expect(book.rows[1]).toEqual(["2026-03-04", "Platform", "7"]);
  });

  it("resolves strings held in the shared table, as Excel writes them", () => {
    const book = open("shared-strings.xlsx");
    expect(book.sheetName).toBe("Q3 detail");
    expect(book.rows[0]).toEqual(["Date", "Team", "Hours"]);
    expect(book.rows.slice(1).map((row) => row[1])).toEqual([
      "Platform",
      "Support",
      "Platform",
      "Platform",
      "Support",
    ]);
  });

  it("refuses a file that is not a spreadsheet, saying which", () => {
    const csv = new TextEncoder().encode(
      "Date,Category,Amount\n2026-03-02,Cloud,1234.56\n2026-03-17,Travel,890.10\n",
    );
    expect(() => readSpreadsheet(csv)).toThrow(SpreadsheetError);
    expect(() => readSpreadsheet(csv)).toThrow(/not a readable spreadsheet/u);
  });
});

/**
 * Excel inherited a bug from Lotus 1-2-3: 1900 is treated as a leap year, so
 * serial 60 is 29 February 1900, a day that never existed. Every serial after
 * it is one greater than a plain count of days would give. The expected dates
 * below are what a spreadsheet displays for those serials.
 */
describe("the date serials a spreadsheet stores", () => {
  it.each([
    { serial: 1, iso: "1900-01-01", why: "the first day" },
    { serial: 59, iso: "1900-02-28", why: "the day before the phantom" },
    { serial: 61, iso: "1900-03-01", why: "the day after the phantom" },
    { serial: 366, iso: "1900-12-31", why: "the end of the first year" },
    { serial: 46083, iso: "2026-03-02", why: "a date in the fixture" },
    { serial: 45658, iso: "2025-01-01", why: "a recent new year" },
  ])("reads serial $serial as $iso ($why)", ({ serial, iso }) => {
    expect(serialToIsoDate(serial, false)).toBe(iso);
  });

  it("refuses the phantom day rather than naming a real one", () => {
    expect(serialToIsoDate(60, false)).toBeUndefined();
  });

  it("refuses zero and negatives, which name no date", () => {
    expect(serialToIsoDate(0, false)).toBeUndefined();
    expect(serialToIsoDate(-5, false)).toBeUndefined();
  });

  it("counts from 1904 in a workbook that says so", () => {
    // The 1904 epoch has no phantom day, so day 0 is the epoch itself.
    expect(serialToIsoDate(0, true)).toBe("1904-01-01");
    expect(serialToIsoDate(1, true)).toBe("1904-01-02");
  });

  it("keeps only the day from a serial carrying a time", () => {
    expect(serialToIsoDate(46083.75, false)).toBe("2026-03-02");
  });
});

describe("telling a date format from one that only looks like one", () => {
  it.each([
    "yyyy-mm-dd",
    "d mmm yyyy",
    "m/d/yy h:mm",
    "[$-409]dddd, mmmm dd, yyyy",
  ])("reads %s as a date", (code) => {
    expect(looksLikeDateFormat(code)).toBe(true);
  });

  it.each([
    "0.00",
    "#,##0.00",
    '"$"#,##0.00',
    "General",
    '0.0" days"',
    "#,##0;[Red]\\-#,##0",
  ])("does not read %s as a date", (code) => {
    // The traps: a currency or unit literal in quotes, an escaped character,
    // and a bracketed colour, each of which can carry a d, m, s or y.
    expect(looksLikeDateFormat(code)).toBe(false);
  });
});

describe("cell addresses", () => {
  it.each([
    { reference: "A1", column: 0 },
    { reference: "B12", column: 1 },
    { reference: "Z3", column: 25 },
    { reference: "AA1", column: 26 },
    { reference: "AZ9", column: 51 },
    { reference: "BA1", column: 52 },
    { reference: "XFD1048576", column: 16383 },
  ])("reads $reference as column $column", ({ reference, column }) => {
    expect(columnOf(reference)).toBe(column);
  });
});
