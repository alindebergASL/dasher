/**
 * Tables the tests share: the two sample files, and a small in-memory table
 * with no period column.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { profileTable, readTable, type Table } from "@dasher/workbook";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "..", "..", "..", "fixtures", "sample");

export function transactionsTable(): Table {
  return readTable(readFileSync(join(fixtures, "transactions.csv"), "utf8"));
}

export function wideTable(): Table {
  return readTable(
    readFileSync(join(fixtures, "operating-spend-wide.csv"), "utf8"),
  );
}

/** Six rows, three categories, amounts in cents, no date. */
export function flatTable(): Table {
  return profileTable({
    headers: ["Team", "Item", "Cost"],
    rows: [
      ["Ops", "Chairs", "$120.50"],
      ["Ops", "Desks", "$300.25"],
      ["Eng", "Laptops", "$2,400.00"],
      ["Eng", "Monitors", "$600.00"],
      ["Sales", "Travel", "$79.25"],
      ["Sales", "Dinner", "n/a"],
    ],
  });
}

export const AS_OF = "2026-09-04T12:00:00.000Z";
export const RETRIEVED_AT = "2026-09-04T11:59:00.000Z";

export function sourceFor(table: Table, name: string) {
  return {
    name,
    retrievedAt: RETRIEVED_AT,
    rowCount: table.rowCount,
    sha256: "ab".repeat(32),
  };
}

/** Card-style amounts: every charge is negative and Payroll dwarfs the rest. */
export function negativeTable(): Table {
  return profileTable({
    headers: ["Date", "Category", "Amount"],
    rows: [
      ["2026-01-01", "Payroll", "-1000000"],
      ["2026-01-02", "Rent", "-50000"],
      ["2026-01-03", "Coffee", "-10"],
    ],
  });
}

/** Eng spends on three rows but states its budget on only one of them. */
export function partialBudgetTable(): Table {
  return profileTable({
    headers: ["Date", "Category", "Amount", "Budget"],
    rows: [
      ["2026-01-01", "Eng", "1000", "1200"],
      ["2026-01-02", "Eng", "900", ""],
      ["2026-01-03", "Eng", "800", ""],
      ["2026-01-04", "Ops", "100", "500"],
    ],
  });
}

/**
 * Categories whose names sit inside one another and inside ordinary words:
 * five distinct values fill the sample cap, so "E" is only in the file.
 */
export function travelTable(): Table {
  return profileTable({
    headers: ["Date", "Category", "Amount"],
    rows: [
      ["2026-01-05", "Travel", "100"],
      ["2026-01-05", "A", "100"],
      ["2026-01-05", "IN", "100"],
      ["2026-01-05", "OUT", "100"],
      ["2026-01-05", "Marketing", "100"],
      ["2026-01-05", "E", "100"],
    ],
  });
}

/** A period column of its own, coarser than any plan's default grain. */
export function quarterlyTable(): Table {
  return profileTable({
    headers: ["Quarter", "Category", "Amount"],
    rows: [
      ["Q1 2026", "Ops", "150"],
      ["Q1 2026", "Eng", "250"],
      ["Q2 2026", "Ops", "260"],
      ["Q2 2026", "Eng", "140"],
    ],
  });
}

/** One period whose amounts cancel out exactly, so the total is zero. */
export function zeroTotalTable(): Table {
  return profileTable({
    headers: ["Date", "Category", "Amount"],
    rows: [
      ["2026-01-01", "In", "100"],
      ["2026-01-02", "Out", "-100"],
    ],
  });
}

/** More categories than any ranking shows, so the ranking must say so. */
export function manyCategoriesTable(count: number): Table {
  return profileTable({
    headers: ["Date", "Category", "Amount"],
    rows: Array.from({ length: count }, (_, index) => [
      "2026-01-01",
      `Cat ${String(index + 1).padStart(3, "0")}`,
      String(count - index),
    ]),
  });
}

/** Two rows whose category cell is empty, next to two that are not. */
export function blankCategoryTable(): Table {
  return profileTable({
    headers: ["Date", "Category", "Amount"],
    rows: [
      ["2026-01-01", "Ops", "100"],
      ["2026-01-02", "", "40"],
      ["2026-01-03", "Ops", "60"],
      ["2026-01-04", "", "10"],
    ],
  });
}

/** Amounts that need two decimals and one that rounds up at the money scale. */
export function centsTable(): Table {
  return profileTable({
    headers: ["Date", "Category", "Amount"],
    rows: [
      ["2026-01-01", "Ops", "$5.00"],
      ["2026-02-01", "Ops", "$10.005"],
    ],
  });
}

/** The column a test needs by name. */
export function columnNamed(table: Table, name: string) {
  const column = table.columns.find((one) => one.name === name);
  if (column === undefined) throw new Error(`No column named ${name}`);
  return column;
}
