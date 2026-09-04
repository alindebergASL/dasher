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
