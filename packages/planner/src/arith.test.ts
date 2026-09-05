import { describe, expect, it } from "vitest";

import {
  allocatePercents,
  formatMoney,
  formatSignedPercent,
  percentOf,
} from "./arith";

describe("percentOf", () => {
  it.each([
    ["7875", "42000", "18.8"],
    ["-4226.09", "55249.62", "-7.6"],
    ["1", "3", "33.3"],
    ["2", "3", "66.7"],
    ["0.05", "100", "0.1"],
    ["5", "-10", "-50"],
  ])("%s of %s is %s%%", (part, whole, expected) => {
    expect(percentOf(part, whole)).toBe(expected);
  });

  it("has no answer when the whole is zero", () => {
    expect(percentOf("5", "0")).toBeUndefined();
  });
});

describe("allocatePercents", () => {
  it("allocates tenths so the shares sum to exactly one hundred", () => {
    const shares = allocatePercents(["1", "1", "1"]);
    expect(shares).toEqual(["33.4", "33.3", "33.3"]);
    expect(
      allocatePercents(["29430.19", "9509.12", "7382.06", "3.3"]).length,
    ).toBe(4);
  });

  it("rounds plainly when a part is negative", () => {
    expect(allocatePercents(["150", "-50"])).toEqual(["150", "-50"]);
  });
});

describe("formatting", () => {
  it("formats money with grouping, exact decimals, and the currency's symbol", () => {
    expect(formatMoney("1234567.5", { currency: "USD", decimals: 2 })).toBe(
      "$1,234,567.50",
    );
    expect(formatMoney("-42", { currency: "EUR", decimals: 0 })).toBe("-€42");
    expect(formatMoney("999", { decimals: 0 })).toBe("999");
    expect(formatMoney("0.005", { currency: "GBP", decimals: 2 })).toBe(
      "£0.01",
    );
  });

  it("signs percentages", () => {
    expect(formatSignedPercent("12.34")).toBe("+12.3%");
    expect(formatSignedPercent("-0.04")).toBe("0.0%");
    expect(formatSignedPercent("0")).toBe("0.0%");
  });
});
