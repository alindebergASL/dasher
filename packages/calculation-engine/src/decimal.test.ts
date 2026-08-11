import { describe, expect, it } from "vitest";

import {
  I64_MAX,
  I64_MIN,
  canonicalizeDecimal,
  coefficientDigits,
  decimalToRational,
  formatTaggedI64,
  integerToRational,
  parseDecimalObject,
  parseTaggedI64,
  quantize,
  ratAbs,
  ratAdd,
  ratCompare,
  ratDivide,
  ratIsZero,
  ratMultiply,
  ratSubtract,
  rational,
} from "./decimal";

describe("tagged i64", () => {
  it("parses the lossless signed-64 boundaries without JavaScript number", () => {
    expect(parseTaggedI64("i64:9223372036854775807")).toBe(I64_MAX);
    expect(parseTaggedI64("i64:-9223372036854775808")).toBe(I64_MIN);
    expect(I64_MAX).toBe(9223372036854775807n);
    expect(I64_MIN).toBe(-9223372036854775808n);
  });

  it("round-trips values that are not representable as a double", () => {
    const text = "i64:9007199254740993";
    const parsed = parseTaggedI64(text);
    expect(parsed).toBe(9007199254740993n);
    expect(formatTaggedI64(parsed as bigint)).toBe(text);
  });

  it("rejects one past each signed-64 boundary", () => {
    expect(parseTaggedI64("i64:9223372036854775808")).toBeNull();
    expect(parseTaggedI64("i64:-9223372036854775809")).toBeNull();
  });

  it("rejects noncanonical spellings", () => {
    for (const bad of [
      "i64:+1",
      "i64:01",
      "i64:-0",
      "i64: 1",
      "i64:1 ",
      "i64:",
      "i64:1.0",
      "i64:0x1",
      "I64:1",
      "1",
      "i64:１",
    ]) {
      expect(parseTaggedI64(bad)).toBeNull();
    }
  });

  it("rejects non-string and JSON number inputs", () => {
    expect(parseTaggedI64(1 as unknown)).toBeNull();
    expect(parseTaggedI64(null)).toBeNull();
    expect(parseTaggedI64(undefined)).toBeNull();
  });

  it("formats zero and negatives canonically", () => {
    expect(formatTaggedI64(0n)).toBe("i64:0");
    expect(formatTaggedI64(-7n)).toBe("i64:-7");
  });
});

describe("canonical decimal objects", () => {
  it("accepts a canonical pair", () => {
    expect(parseDecimalObject({ coefficient: "925", scale: "i64:3" })).toEqual({
      coefficient: 925n,
      scale: 3n,
    });
  });

  it("rejects an unreduced trailing-zero spelling", () => {
    expect(
      parseDecimalObject({ coefficient: "10000", scale: "i64:2" }),
    ).toBeNull();
  });

  it("requires zero to be coefficient 0 at scale 0", () => {
    expect(parseDecimalObject({ coefficient: "0", scale: "i64:0" })).toEqual({
      coefficient: 0n,
      scale: 0n,
    });
    expect(parseDecimalObject({ coefficient: "0", scale: "i64:1" })).toBeNull();
    expect(
      parseDecimalObject({ coefficient: "-0", scale: "i64:0" }),
    ).toBeNull();
  });

  it("rejects 39 coefficient digits and accepts 38", () => {
    const d38 = "9".repeat(38);
    const d39 = "9".repeat(39);
    expect(parseDecimalObject({ coefficient: d38, scale: "i64:0" })).toEqual({
      coefficient: BigInt(d38),
      scale: 0n,
    });
    expect(parseDecimalObject({ coefficient: d39, scale: "i64:0" })).toBeNull();
    expect(
      parseDecimalObject({ coefficient: `-${d38}`, scale: "i64:18" }),
    ).toEqual({ coefficient: -BigInt(d38), scale: 18n });
  });

  it("rejects scale outside i64:0..i64:18 and unknown keys", () => {
    expect(
      parseDecimalObject({ coefficient: "1", scale: "i64:19" }),
    ).toBeNull();
    expect(
      parseDecimalObject({ coefficient: "1", scale: "i64:-1" }),
    ).toBeNull();
    expect(
      parseDecimalObject({ coefficient: "1", scale: "i64:0", extra: null }),
    ).toBeNull();
    expect(parseDecimalObject({ coefficient: "1" })).toBeNull();
  });

  it("rejects noncanonical coefficient text", () => {
    for (const coefficient of ["01", "+1", "1.0", " 1", "", "1e3"]) {
      expect(parseDecimalObject({ coefficient, scale: "i64:0" })).toBeNull();
    }
  });

  it("counts coefficient digits excluding sign", () => {
    expect(coefficientDigits(0n)).toBe(1n);
    expect(coefficientDigits(-925n)).toBe(3n);
    expect(coefficientDigits(BigInt("9".repeat(38)))).toBe(38n);
  });

  it("canonicalizes by stripping trailing zeroes while scale is positive", () => {
    expect(canonicalizeDecimal(9250n, 2n)).toEqual({
      coefficient: 925n,
      scale: 1n,
    });
    expect(canonicalizeDecimal(100n, 0n)).toEqual({
      coefficient: 100n,
      scale: 0n,
    });
    expect(canonicalizeDecimal(0n, 5n)).toEqual({ coefficient: 0n, scale: 0n });
  });
});

describe("exact rationals", () => {
  it("sign-normalizes and reduces once", () => {
    expect(rational(2n, -4n)).toEqual({ n: -1n, d: 2n });
    expect(rational(0n, -3n)).toEqual({ n: 0n, d: 1n });
  });

  it("converts integer and decimal inputs directly", () => {
    expect(integerToRational(-3n)).toEqual({ n: -3n, d: 1n });
    expect(decimalToRational({ coefficient: 925n, scale: 3n })).toEqual({
      n: 37n,
      d: 40n,
    });
  });

  it("performs the four exact operations", () => {
    const a = rational(1n, 3n);
    const b = rational(1n, 6n);
    expect(ratAdd(a, b)).toEqual({ n: 1n, d: 2n });
    expect(ratSubtract(a, b)).toEqual({ n: 1n, d: 6n });
    expect(ratMultiply(a, b)).toEqual({ n: 1n, d: 18n });
    expect(ratDivide(a, b)).toEqual({ n: 2n, d: 1n });
    expect(ratDivide(a, rational(0n, 1n))).toBeNull();
    expect(ratIsZero(rational(0n, 5n))).toBe(true);
    expect(ratAbs(rational(-3n, 4n))).toEqual({ n: 3n, d: 4n });
    expect(ratCompare(a, b)).toBe(1);
    expect(ratCompare(b, a)).toBe(-1);
    expect(ratCompare(a, a)).toBe(0);
  });
});

describe("one final quantization", () => {
  it("requires exact termination for rounding none", () => {
    expect(quantize(rational(1n, 2n), 1n, "none")).toEqual({
      ok: true,
      value: { coefficient: 5n, scale: 1n },
    });
    expect(quantize(rational(1n, 3n), 18n, "none")).toEqual({
      ok: false,
      reason: "inexact",
    });
  });

  it("uses symmetric ties-to-even", () => {
    expect(quantize(rational(5n, 100n), 1n, "half_even")).toEqual({
      ok: true,
      value: { coefficient: 0n, scale: 0n },
    });
    expect(quantize(rational(15n, 100n), 1n, "half_even")).toEqual({
      ok: true,
      value: { coefficient: 2n, scale: 1n },
    });
    expect(quantize(rational(-15n, 100n), 1n, "half_even")).toEqual({
      ok: true,
      value: { coefficient: -2n, scale: 1n },
    });
    expect(quantize(rational(25n, 100n), 1n, "half_even")).toEqual({
      ok: true,
      value: { coefficient: 2n, scale: 1n },
    });
    expect(quantize(rational(-25n, 100n), 1n, "half_even")).toEqual({
      ok: true,
      value: { coefficient: -2n, scale: 1n },
    });
    expect(quantize(rational(35n, 100n), 1n, "half_even")).toEqual({
      ok: true,
      value: { coefficient: 4n, scale: 1n },
    });
  });

  it("checks the 38-digit coefficient ceiling before canonical stripping", () => {
    const c38 = BigInt("9".repeat(38));
    expect(quantize(rational(c38, 1n), 0n, "none")).toEqual({
      ok: true,
      value: { coefficient: c38, scale: 0n },
    });
    expect(quantize(rational(c38 * 10n, 1n), 0n, "none")).toEqual({
      ok: false,
      reason: "overflow",
    });
    expect(quantize(rational(-c38 * 10n, 1n), 0n, "none")).toEqual({
      ok: false,
      reason: "overflow",
    });
  });

  it("strips a quantized trailing zero after the ceiling check", () => {
    // 100 * 925/1000 = 92.5 quantized at the EUR exponent 2 -> 9250/2 -> 925/1.
    expect(
      quantize(
        ratMultiply(rational(100n, 1n), rational(925n, 1000n)),
        2n,
        "half_even",
      ),
    ).toEqual({ ok: true, value: { coefficient: 925n, scale: 1n } });
  });
});
