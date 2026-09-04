import { describe, expect, it } from "vitest";

import {
  bucketPeriod,
  comparePeriods,
  detectCurrency,
  parseAmount,
  parseDate,
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
