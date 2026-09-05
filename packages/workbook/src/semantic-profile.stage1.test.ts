import { describe, expect, it } from "vitest";

import { profileTable } from "./infer";
import type { ColumnProfile } from "./table";

type SemanticColumn = ColumnProfile & {
  readonly semanticKind?:
    | "measure"
    | "identifier"
    | "code"
    | "ordinal"
    | "period"
    | "dimension"
    | "unknown";
};

function semanticKinds(columns: readonly ColumnProfile[]) {
  return Object.fromEntries(
    columns.map((column) => [
      column.name,
      (column as SemanticColumn).semanticKind,
    ]),
  );
}

describe("stage 1 canonical column semantics", () => {
  it("keeps common measures distinct from identifiers, codes, ordinals, periods, and dimensions", () => {
    const table = profileTable({
      headers: [
        "Chassis ID",
        "Session ID",
        "Account Number",
        "Customer Number",
        "Employee Number",
        "Order Number",
        "Invoice Number",
        "Phone Number",
        "ZIP Code",
        "Postal Code",
        "SKU",
        "Product Code",
        "Priority Rank",
        "Row Index",
        "Fiscal Period",
        "Region",
        "Amount",
        "Betrag",
        "Total Spend",
        "Revenue",
        "Cost",
        "Budget",
        "Headcount",
        "Customer Count",
        "Quantity",
        "Balance",
        "Conversion Rate",
        "Margin Percent",
        "Units",
      ],
      rows: [
        [
          "101",
          "9001",
          "8001",
          "7001",
          "6001",
          "5001",
          "4001",
          "2125550101",
          "10001",
          "20001",
          "30001",
          "70001",
          "1",
          "0",
          "202601",
          "North",
          "100",
          "1250",
          "1200",
          "5000",
          "700",
          "900",
          "12",
          "40",
          "3",
          "150",
          "0.25",
          "18",
          "6",
        ],
        [
          "102",
          "9002",
          "8002",
          "7002",
          "6002",
          "5002",
          "4002",
          "2125550102",
          "10002",
          "20002",
          "30002",
          "70002",
          "2",
          "1",
          "202602",
          "South",
          "110",
          "1300",
          "900",
          "4800",
          "750",
          "950",
          "11",
          "38",
          "4",
          "175",
          "0.3",
          "20",
          "8",
        ],
        [
          "103",
          "9003",
          "8003",
          "7003",
          "6003",
          "5003",
          "4003",
          "2125550103",
          "10003",
          "20003",
          "30003",
          "70003",
          "3",
          "2",
          "202603",
          "West",
          "120",
          "1400",
          "1100",
          "5100",
          "800",
          "1000",
          "13",
          "42",
          "5",
          "200",
          "0.35",
          "22",
          "10",
        ],
      ],
    });

    expect(semanticKinds(table.columns)).toStrictEqual({
      "Chassis ID": "identifier",
      "Session ID": "identifier",
      "Account Number": "identifier",
      "Customer Number": "identifier",
      "Employee Number": "identifier",
      "Order Number": "identifier",
      "Invoice Number": "identifier",
      "Phone Number": "identifier",
      "ZIP Code": "code",
      "Postal Code": "code",
      SKU: "code",
      "Product Code": "code",
      "Priority Rank": "ordinal",
      "Row Index": "ordinal",
      "Fiscal Period": "period",
      Region: "dimension",
      Amount: "measure",
      Betrag: "measure",
      "Total Spend": "measure",
      Revenue: "measure",
      Cost: "measure",
      Budget: "measure",
      Headcount: "measure",
      "Customer Count": "measure",
      Quantity: "measure",
      Balance: "measure",
      "Conversion Rate": "measure",
      "Margin Percent": "measure",
      Units: "measure",
    });
  });

  it("fails ambiguous numeric headers closed while respecting exact-word near misses", () => {
    const table = profileTable({
      headers: [
        "Value",
        "Metric 1",
        "Identity Score",
        "Budget Code",
        "Customer Count ID",
        "Ranked Revenue",
        "Fiscal Year Amount",
      ],
      rows: [
        ["10", "20", "30", "40", "50", "60", "70"],
        ["11", "21", "31", "41", "51", "61", "71"],
      ],
    });

    expect(semanticKinds(table.columns)).toStrictEqual({
      Value: "unknown",
      "Metric 1": "unknown",
      "Identity Score": "unknown",
      "Budget Code": "code",
      "Customer Count ID": "identifier",
      "Ranked Revenue": "measure",
      "Fiscal Year Amount": "measure",
    });
  });

  it("uses explicit currency evidence for an otherwise ambiguous numeric header", () => {
    const table = profileTable({
      headers: ["Ledger Field"],
      rows: [["$10.00"], ["$12.50"]],
    });

    expect(table.columns[0]?.semanticKind).toBe("measure");
  });
});
