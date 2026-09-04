import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { add } from "./exact";
import { profileTable } from "./infer";
import { parseAmount, parseDate } from "./parse-values";
import { TableRefused, detectDelimiter, readTable } from "./read";
import { unpivotIfWide } from "./unpivot";

const wideSample = readFileSync(
  new URL("../../../fixtures/sample/operating-spend-wide.csv", import.meta.url),
  "utf8",
);

const transactions = [
  "Date,Description,Category,Amount,Account",
  '2026-03-02,"Coffee, beans",Food,"$1,234.50",Checking',
  "2026-03-03,Refund,Food,(45.00),Checking",
  "2026-03-05,Rent,Housing,$2000,Checking",
  "2026-03-07,Salary,Income,$5400.00,Savings",
  "",
].join("\n");

describe("readTable on a transactions export", () => {
  const table = readTable(transactions);

  it("types the columns by their cells", () => {
    expect(
      table.columns.map((column) => [column.name, column.type]),
    ).toStrictEqual([
      ["Date", "date"],
      ["Description", "text"],
      ["Category", "text"],
      ["Amount", "number"],
      ["Account", "text"],
    ]);
  });

  it("keeps cells as trimmed text and records the currency", () => {
    const amount = table.columns[3];
    expect(amount?.currency).toBe("USD");
    expect(amount?.nonEmpty).toBe(4);
    expect(amount?.distinct).toBe(4);
    expect(table.rows[0]?.[3]).toBe("$1,234.50");
    expect(table.rows[1]?.[3]).toBe("(45.00)");
    expect(table.rowCount).toBe(4);
    expect(table.unpivoted).toBeUndefined();
  });

  it("profiles distinct values and samples", () => {
    const category = table.columns[2];
    expect(category?.distinct).toBe(3);
    expect(category?.samples).toStrictEqual(["Food", "Housing", "Income"]);
  });
});

describe("delimiters", () => {
  it("detects a semicolon-delimited file", () => {
    const text =
      "Datum;Betrag;Konto\n2026-03-01;1.234,56;Giro\n2026-03-02;-12,50;Giro\n";
    expect(detectDelimiter(text)).toBe(";");
    const table = readTable(text);
    expect(table.columns.map((column) => column.type)).toStrictEqual([
      "date",
      "number",
      "text",
    ]);
    expect(table.rows[0]).toStrictEqual(["2026-03-01", "1.234,56", "Giro"]);
  });

  it("detects tabs and pipes, and defaults to a comma", () => {
    expect(detectDelimiter("a\tb\n1\t2\n")).toBe("\t");
    expect(detectDelimiter("a|b|c\n1|2|3\n")).toBe("|");
    expect(detectDelimiter("a\n1\n")).toBe(",");
  });

  it("ignores delimiters inside quoted cells", () => {
    expect(detectDelimiter('a,b\n"x;y;z",2\n"p;q",3\n')).toBe(",");
  });

  it("honours an explicit delimiter", () => {
    const table = readTable("a;b\n1;2\n", { delimiter: ";" });
    expect(table.columns.map((column) => column.name)).toStrictEqual([
      "a",
      "b",
    ]);
  });
});

describe("a wide file with one column per period", () => {
  const table = readTable(wideSample);

  it("unpivots to one row per line and period", () => {
    expect(table.rowCount).toBe(36);
    expect(table.columns.map((column) => column.name)).toStrictEqual([
      "line_id",
      "label",
      "budget",
      "period",
      "amount",
    ]);
    expect(table.unpivoted).toStrictEqual({
      periodColumns: [
        "2026-03",
        "2026-04",
        "2026-05",
        "2026-06",
        "2026-07",
        "2026-08",
      ],
      periodColumn: "period",
      amountColumn: "amount",
      budgetColumn: "budget",
    });
  });

  it("repeats the line's columns for each period", () => {
    expect(table.rows[0]).toStrictEqual([
      "cloud",
      "Cloud infrastructure",
      "42000",
      "2026-03",
      "38100",
    ]);
    expect(table.rows[5]).toStrictEqual([
      "cloud",
      "Cloud infrastructure",
      "42000",
      "2026-08",
      "49875",
    ]);
    expect(table.rows[35]?.[0]).toBe("facilities");
  });

  it("types the new columns", () => {
    const types = Object.fromEntries(
      table.columns.map((column) => [column.name, column.type]),
    );
    expect(types).toStrictEqual({
      line_id: "text",
      label: "text",
      budget: "number",
      period: "text",
      amount: "number",
    });
  });

  it("uses month headers written the way a spreadsheet writes them", () => {
    const text = "Team,Mar 2026,Apr 2026,Total\nOps,10,20,30\nEng,5,5,10\n";
    const table = readTable(text);
    expect(table.unpivoted?.periodColumns).toStrictEqual([
      "Mar 2026",
      "Apr 2026",
    ]);
    expect(table.columns.map((column) => column.name)).toStrictEqual([
      "Team",
      "Total",
      "period",
      "amount",
    ]);
    expect(table.rows[1]).toStrictEqual(["Ops", "30", "2026-04", "20"]);
  });

  it("leaves a long file alone", () => {
    const long = profileTable({
      headers: ["period", "amount"],
      rows: [["2026-03", "1"]],
    });
    expect(unpivotIfWide(long)).toBe(long);
  });

  it("does not unpivot on a single period header", () => {
    const table = readTable("Team,2026,Notes\nOps,10,x\n");
    expect(table.unpivoted).toBeUndefined();
  });
});

describe("columns with nothing in them", () => {
  it("keeps a blank column as empty text", () => {
    const table = readTable(
      "Date,Amount,Notes\n2026-03-01,10,\n2026-03-02,20,\n",
    );
    const notes = table.columns[2];
    expect(notes).toMatchObject({
      type: "text",
      nonEmpty: 0,
      distinct: 0,
      samples: [],
    });
    expect(table.rows[0]).toStrictEqual(["2026-03-01", "10", ""]);
  });

  it("types a column by the majority of its non-empty cells", () => {
    const table = readTable("Amount\n10\n\n20\nn/a\n30\n40\n50\n");
    expect(table.columns[0]?.type).toBe("number");
    expect(table.columns[0]?.nonEmpty).toBe(6);
  });
});

describe("refusals", () => {
  function refusal(text: string): string | undefined {
    try {
      readTable(text);
      return undefined;
    } catch (error) {
      return error instanceof TableRefused ? error.reason : "not_a_refusal";
    }
  }

  it("refuses a text-only file", () => {
    expect(refusal("Name,City\nAda,London\nAlan,Manchester\n")).toBe(
      "no_numeric_column",
    );
  });

  it("refuses a header with no rows", () => {
    expect(refusal("Date,Amount\n")).toBe("no_rows");
  });

  it("carries the CSV parser's reasons", () => {
    expect(refusal("")).toBe("empty");
    expect(refusal("a,,c\n1,2,3\n")).toBe("blank_header");
    expect(refusal("a,b\n1,2,3\n")).toBe("ragged_row");
    expect(refusal('a,b\n"open,2\n')).toBe("unclosed_quote");
  });

  it("names the reason in the error", () => {
    expect(() => readTable("Name\nAda\n")).toThrow(/no_numeric_column/u);
  });
});

describe("a ledger in Excel's Accounting format", () => {
  const ledger = [
    "Item,Amount",
    'Ads,"$2,500.00"',
    'Hosting,"$2,500.00"',
    'Travel,"$2,500.00"',
    'Software,"$2,500.00"',
    'Refund,"$(5,000.00)"',
    "",
  ].join("\n");

  it("reads the refund as negative, so the column totals what it says", () => {
    const table = readTable(ledger);
    const amount = table.columns[1];
    expect(amount?.type).toBe("number");
    expect(amount?.currency).toBe("USD");

    const total = table.rows.reduce(
      (running, row) => add(running, parseAmount(row[1] ?? "") ?? "0"),
      "0",
    );
    expect(total).toBe("5000");
  });
});

describe("a European file", () => {
  const european = [
    "Datum;Betrag;Konto",
    "15/01/2026;1.234,56;Giro",
    "01/02/2026;1.250;Giro",
    "01/03/2026;980,50;Giro",
    "",
  ].join("\n");

  const table = readTable(european);

  it("names the conventions its columns are written in", () => {
    expect(table.columns.map((column) => column.type)).toStrictEqual([
      "date",
      "number",
      "text",
    ]);
    expect(table.columns[0]?.dates).toBe("day-first");
    expect(table.columns[1]?.decimal).toBe("comma");
  });

  it("reads every amount under the column's convention", () => {
    const decimal = table.columns[1]?.decimal;
    expect(
      table.rows.map((row) => parseAmount(row[1] ?? "", { decimal })),
    ).toStrictEqual(["1234.56", "1250", "980.5"]);
  });

  it("reads every date under the column's convention", () => {
    const dates = table.columns[0]?.dates;
    expect(
      table.rows.map((row) => parseDate(row[0] ?? "", { dates })?.iso),
    ).toStrictEqual([
      "2026-01-15T00:00:00.000Z",
      "2026-02-01T00:00:00.000Z",
      "2026-03-01T00:00:00.000Z",
    ]);
  });

  it("refuses to read dates from a column that contradicts itself", () => {
    const mixed = readTable(
      "Date,Amount\n15/03/2026,10\n03/15/2026,20\n01/02/2026,30\n",
    );
    expect(mixed.columns[0]?.type).toBe("text");
    expect(mixed.columns[0]?.dates).toBeUndefined();
  });
});

describe("a column of quantities", () => {
  it("is text, not an amount: PCS is not a currency", () => {
    const table = readTable(
      "Part,Count,Cost\nbolt,100 PCS,10\nnut,50 PCS,20\n",
    );
    expect(table.columns[1]?.type).toBe("text");
    expect(table.columns[2]?.type).toBe("number");
  });
});

describe("unpivoting a file whose columns already use the new names", () => {
  it("gives every column a name no other column has", () => {
    const table = profileTable({
      headers: ["period", "period_1", "2026-03", "2026-04"],
      rows: [["a", "b", "10", "20"]],
    });
    const wide = unpivotIfWide(table);
    const names = wide.columns.map((column) => column.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toStrictEqual(["period_2", "period_1", "period", "amount"]);
  });

  it("types the new columns at the threshold the caller asked for", () => {
    const text = "label,2026-03,2026-04\na,10,20\nb,30,x\n";
    const table = readTable(text, { typeThreshold: 0.5 });
    const types = Object.fromEntries(
      table.columns.map((column) => [column.name, column.type]),
    );
    expect(types).toStrictEqual({
      label: "text",
      period: "text",
      amount: "number",
    });
  });
});

describe("a ledger stamped on the first of every month", () => {
  /**
   * No component is ever over twelve, so the date column cannot say which
   * order it is in. The rest of the file can: a semicolon delimiter and a comma
   * decimal mark come from the locale that writes the day first.
   */
  const monthly = [
    "Datum;Kategorie;Betrag",
    "01/01/2026;Miete;1.250",
    "01/02/2026;Miete;1.250",
    "01/03/2026;Gehalt;12.500",
    '01/04/2026;Gehalt;"12.500,50"',
    "",
  ].join("\n");

  it("reads four months rather than four days of January", () => {
    const table = readTable(monthly);
    expect(table.columns[0]?.type).toBe("date");
    expect(table.columns[0]?.dates).toBe("day-first");
    const dates = table.columns[0]?.dates;
    expect(
      table.rows.map((row) =>
        parseDate(row[0] ?? "", { dates })?.iso.slice(0, 7),
      ),
    ).toStrictEqual(["2026-01", "2026-02", "2026-03", "2026-04"]);
  });

  it("reads the dotted thousands as thousands", () => {
    const table = readTable(monthly);
    const decimal = table.columns[2]?.decimal;
    expect(decimal).toBe("comma");
    expect(
      table.rows.map((row) => parseAmount(row[2] ?? "", { decimal })),
    ).toStrictEqual(["1250", "1250", "12500", "12500.5"]);
  });

  it("lets a date in the column itself overrule the file's locale", () => {
    const table = readTable(
      "Datum;Betrag\n03/15/2026;1.250\n04/01/2026;2.500\n",
    );
    expect(table.columns[0]?.dates).toBe("month-first");
  });

  it("does not read a comma-delimited file as day-first without evidence", () => {
    const table = readTable("Date,Amount\n01/02/2026,10\n01/03/2026,20\n");
    expect(table.columns[0]?.dates).toBe("month-first");
  });
});
