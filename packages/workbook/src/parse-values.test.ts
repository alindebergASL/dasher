import { describe, expect, it } from "vitest";

import {
  bucketPeriod,
  comparePeriods,
  dateConvention,
  decimalConvention,
  detectCurrency,
  parseAmount,
  parseAmountsInColumn,
  parseDate,
  parseDatesInColumn,
  parsePeriodHeader,
  periodLabel,
  periodStartIso,
} from "./parse-values";

describe("parseAmount", () => {
  it.each([
    ["1,234.56", "1234.56"],
    ["$1,234", "1234"],
    ["€ 12", "12"],
    ["£12", "12"],
    ["(500)", "-500"],
    ["($45.00)", "-45"],
    ["-500", "-500"],
    ["-$500", "-500"],
    ["12%", "12"],
    ["1 234,56", "1234.56"],
    ["1 234", "1234"],
    ["1.234,56", "1234.56"],
    ["12,50", "12.5"],
    ["  42  ", "42"],
    ["USD 12", "12"],
    ["12 EUR", "12"],
    ["+7.5", "7.5"],
    ["0.00", "0"],
    ["(0)", "0"],
  ])("reads %j as %j", (text, expected) => {
    expect(parseAmount(text)).toBe(expected);
  });

  it.each(["", "-", "—", "n/a", "abc", "12abc", "2026-03-01", "1,23,4", "--5"])(
    "returns null for %j",
    (text) => {
      expect(parseAmount(text)).toBeNull();
    },
  );
});

describe("detectCurrency", () => {
  it.each([
    ["$1,234", "USD"],
    ["€ 12", "EUR"],
    ["£12", "GBP"],
    ["USD 12", "USD"],
    ["12 GBP", "GBP"],
    ["(€45)", "EUR"],
    ["1234", undefined],
    ["ABC 12", undefined],
  ])("finds the currency in %j", (text, expected) => {
    expect(detectCurrency(text)).toBe(expected);
  });
});

describe("parseDate", () => {
  const march = "2026-03-01T00:00:00.000Z";

  it.each([
    ["2026-03-01", march],
    ["2026-03-01T14:22:00Z", march],
    ["2026-03-01 14:22", march],
    ["2026/03/01", march],
    ["3/1/2026", march],
    ["03/01/26", march],
    ["01-Mar-2026", march],
    ["1 March 2026", march],
    ["Mar 1, 2026", march],
    ["Mar 2026", march],
    ["March 2026", march],
    ["2026-03", march],
    ["12/31/2025", "2025-12-31T00:00:00.000Z"],
  ])("reads %j as midnight UTC", (text, expected) => {
    expect(parseDate(text)).toStrictEqual({ iso: expected });
  });

  it.each(["", "2026", "42", "2026-13-01", "2/30/2026", "Foo 2026", "Mar-26"])(
    "returns null for %j",
    (text) => {
      expect(parseDate(text)).toBeNull();
    },
  );
});

describe("parsePeriodHeader", () => {
  it.each([
    ["2026-03", "2026-03", "month"],
    ["2026/03", "2026-03", "month"],
    ["Mar 2026", "2026-03", "month"],
    ["March 2026", "2026-03", "month"],
    ["Mar-26", "2026-03", "month"],
    ["2026-03-01", "2026-03", "month"],
    ["2026-Q1", "2026-Q1", "quarter"],
    ["Q1 2026", "2026-Q1", "quarter"],
    ["FY2026", "2026", "year"],
    ["FY26", "2026", "year"],
    ["2026", "2026", "year"],
  ])("reads %j as %j at %s grain", (text, key, grain) => {
    expect(parsePeriodHeader(text)).toStrictEqual({ key, grain });
  });

  it.each(["label", "budget", "2026-03-15", "Q5 2026", "12", "Total"])(
    "returns null for %j",
    (text) => {
      expect(parsePeriodHeader(text)).toBeNull();
    },
  );
});

describe("period buckets", () => {
  const iso = "2026-05-17T00:00:00.000Z";

  it("buckets a date at each grain", () => {
    expect(bucketPeriod(iso, "month")).toBe("2026-05");
    expect(bucketPeriod(iso, "quarter")).toBe("2026-Q2");
    expect(bucketPeriod(iso, "year")).toBe("2026");
  });

  it("finds the start of a bucket", () => {
    expect(periodStartIso("2026-05")).toBe("2026-05-01T00:00:00.000Z");
    expect(periodStartIso("2026-Q2")).toBe("2026-04-01T00:00:00.000Z");
    expect(periodStartIso("2026")).toBe("2026-01-01T00:00:00.000Z");
    expect(() => periodStartIso("May")).toThrow(RangeError);
  });

  it("labels a bucket for a reader", () => {
    expect(periodLabel("2026-05")).toBe("May 2026");
    expect(periodLabel("2026-Q2")).toBe("Q2 2026");
    expect(periodLabel("2026")).toBe("2026");
  });

  it("orders buckets chronologically", () => {
    const shuffled = ["2026-Q1", "2025-12", "2026-01", "2026", "2026-03"];
    expect([...shuffled].sort(comparePeriods)).toStrictEqual([
      "2025-12",
      "2026",
      "2026-Q1",
      "2026-01",
      "2026-03",
    ]);
  });
});

describe("accounting negatives", () => {
  /**
   * Excel's Accounting format writes the symbol outside the parentheses, and a
   * refund read as a positive is a total that is wrong by twice the refund.
   */
  it.each([
    ["($500)", "-500"],
    ["$(500)", "-500"],
    ["$ (1,234.56)", "-1234.56"],
    ["(500)$", "-500"],
    ["£(500)", "-500"],
    ["£ (500)", "-500"],
    ["-$500", "-500"],
    ["$-500", "-500"],
    ["USD (500)", "-500"],
    ["(500) USD", "-500"],
  ])("reads %j as %j", (text, expected) => {
    expect(parseAmount(text)).toBe(expected);
  });

  it.each(["(-500)", "--5", "-(500)", "$(-500)", "(500", "500)"])(
    "returns null for %j",
    (text) => {
      expect(parseAmount(text)).toBeNull();
    },
  );
});

describe("three uppercase letters that are not a currency", () => {
  it.each(["QTY 3", "100 PCS", "3 PCS", "EACH 12"])(
    "returns null for %j",
    (text) => {
      expect(parseAmount(text)).toBeNull();
    },
  );

  it("still reads a real currency code", () => {
    expect(parseAmount("USD 12")).toBe("12");
    expect(parseAmount("12 EUR")).toBe("12");
  });
});

describe("the decimal mark a column uses", () => {
  it("infers the mark from the cells that can only be read one way", () => {
    expect(decimalConvention(["1.234,56", "1.250", "980,50"])).toBe("comma");
    expect(decimalConvention(["1,234.56", "1,250", "980.50"])).toBe("dot");
    expect(decimalConvention(["1.250", "2.500"])).toBe("dot");
  });

  it("reads every cell of a column under one convention", () => {
    // `1.250` and `1,250` are the same shape; a column may not read one as
    // thousands and the other as a fraction.
    expect(parseAmountsInColumn(["1.234,56", "1.250", "980,50"])).toStrictEqual([
      "1234.56",
      "1250",
      "980.5",
    ]);
    expect(parseAmountsInColumn(["1,234.56", "1,250", "980.50"])).toStrictEqual([
      "1234.56",
      "1250",
      "980.5",
    ]);
  });

  it("keeps the US reading when no cell shows the convention", () => {
    expect(parseAmountsInColumn(["1.250", "2.500"])).toStrictEqual([
      "1.25",
      "2.5",
    ]);
  });

  it("reads one string on its own as US, or under a stated convention", () => {
    expect(parseAmount("1.250")).toBe("1.25");
    expect(parseAmount("1.250", { decimal: "comma" })).toBe("1250");
    expect(parseAmount("1,250", { decimal: "comma" })).toBe("1.25");
    expect(parseAmount("1,250", { decimal: "dot" })).toBe("1250");
    expect(parseAmount("1.234,56", { decimal: "dot" })).toBe("1234.56");
    expect(parseAmount("1,234.56", { decimal: "comma" })).toBe("1234.56");
  });
});

describe("the component order a date column writes", () => {
  it("takes a component over twelve as proof of the order", () => {
    expect(dateConvention(["01/02/2026", "15/03/2026"])).toBe("day-first");
    expect(dateConvention(["01/02/2026", "03/15/2026"])).toBe("month-first");
    expect(dateConvention(["01/02/2026", "01/03/2026"])).toBe("month-first");
    expect(dateConvention(["15/03/2026", "03/15/2026"])).toBe("mixed");
  });

  it("reads every cell of a day-first column as day-first", () => {
    const cells = ["01/02/2026", "01/03/2026", "15/04/2026"];
    expect(parseDatesInColumn(cells).map((date) => date?.iso)).toStrictEqual([
      "2026-02-01T00:00:00.000Z",
      "2026-03-01T00:00:00.000Z",
      "2026-04-15T00:00:00.000Z",
    ]);
  });

  it("reads no dates at all from a column that contradicts itself", () => {
    expect(parseDatesInColumn(["15/03/2026", "03/15/2026"])).toStrictEqual([
      null,
      null,
    ]);
  });

  it("reads one string on its own as month-first, or as told", () => {
    expect(parseDate("01/02/2026")).toStrictEqual({
      iso: "2026-01-02T00:00:00.000Z",
    });
    expect(parseDate("01/02/2026", { dates: "day-first" })).toStrictEqual({
      iso: "2026-02-01T00:00:00.000Z",
    });
    expect(parseDate("31/12/2025", { dates: "day-first" })).toStrictEqual({
      iso: "2025-12-31T00:00:00.000Z",
    });
  });
});
