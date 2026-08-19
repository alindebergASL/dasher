import { describe, expect, it } from "vitest";

import {
  NORMALIZATION_VERSION,
  isNormalizationFailure,
  normalize,
} from "./normalize";

/** Narrows and fails loudly, so a regression reports the value instead of `undefined`. */
function value(text: string): { value: number; unit: string } {
  const result = normalize(text);
  if (isNormalizationFailure(result)) {
    throw new Error(`${JSON.stringify(text)} was refused: ${result.detail}`);
  }
  return result;
}

function failure(text: string): string {
  const result = normalize(text);
  if (!isNormalizationFailure(result)) {
    throw new Error(
      `${JSON.stringify(text)} was accepted as ${String(result.value)} ${result.unit}`,
    );
  }
  return result.kind;
}

describe("counts and thousands separators", () => {
  it("reads a grouped integer", () => {
    expect(value("27,633")).toEqual({ value: 27633, unit: "count" });
  });

  it("reads an ungrouped integer", () => {
    expect(value("3599")).toEqual({ value: 3599, unit: "count" });
  });

  it.each(["2,7633", "27,63", "1,234,56", ",633", "27,"])(
    "refuses %s, where the commas do not group thousands",
    (text) => {
      // Strictness with a purpose: a mis-sliced span often still looks like a
      // number, and accepting these would let a bad locator produce a value.
      expect(failure(text)).toBe("unparseable-number");
    },
  );
});

describe("percentages", () => {
  it("reads a decimal percentage", () => {
    expect(value("4.7%")).toEqual({ value: 4.7, unit: "percent" });
  });

  it("reads a whole percentage", () => {
    expect(value("13%")).toEqual({ value: 13, unit: "percent" });
  });

  it("keeps percent distinct from count", () => {
    expect(value("13%").unit).not.toBe(value("13").unit);
  });
});

describe("space is a separator, not ignorable whitespace", () => {
  // These four were a deterministic lexical FALSE ACCEPTANCE in the first
  // version, which stripped every internal space before validating grouping and
  // so merged adjacent tokens into one valid number. Found in review.
  it.each([
    ["2 7,633", "two tokens, mixed separators"],
    ["1 2 3", "three tokens, none grouped in thousands"],
    ["4. 7%", "a space after the decimal point"],
    ["27 63", "a group that is not three digits"],
  ])("refuses %s (%s)", (text) => {
    expect(isNormalizationFailure(normalize(text))).toBe(true);
  });

  it("still reads a correctly space-grouped number", () => {
    expect(value("27 633")).toEqual({ value: 27633, unit: "count" });
  });

  it("refuses a token mixing comma and space separators", () => {
    expect(failure("2 7,633")).toBe("unparseable-number");
  });

  it("allows the space between a number and its unit", () => {
    expect(value("16.0 µg/m³")).toEqual({ value: 16, unit: "ug_per_m3" });
  });
});

describe("whitespace normalisation", () => {
  // NO corpus candidate exercises these: neither real capture places one of
  // these characters inside a numeric token. They are supported because real
  // documents elsewhere use them, and they are tested here rather than claimed
  // in the report.
  it.each([
    ["27 633", "SPACE"],
    ["27 633", "NO-BREAK SPACE"],
    ["27 633", "NARROW NO-BREAK SPACE"],
    ["27 633", "THIN SPACE"],
  ])("treats %s (%s) as one number", (text) => {
    expect(value(text)).toEqual({ value: 27633, unit: "count" });
  });

  it("trims surrounding whitespace", () => {
    expect(value("  27,633\n")).toEqual({ value: 27633, unit: "count" });
  });
});

describe("sign spellings", () => {
  it.each([
    ["-4.7%", "ASCII hyphen"],
    ["−4.7%", "MINUS SIGN"],
    ["–4.7%", "EN DASH as used in financial tables"],
  ])("reads %s (%s) as negative", (text) => {
    expect(value(text)).toEqual({ value: -4.7, unit: "percent" });
  });
});

describe("unit identities", () => {
  it("maps both micro spellings to one identity", () => {
    // U+00B5 MICRO SIGN and U+03BC GREEK SMALL LETTER MU are visually identical
    // and different code points. Collapsing them is the normalisation; doing it
    // by accident, somewhere else, unversioned, is the bug.
    expect(value("16.0µg/m³")).toEqual({
      value: 16,
      unit: "ug_per_m3",
    });
    expect(value("16.0μg/m³")).toEqual({
      value: 16,
      unit: "ug_per_m3",
    });
  });

  it.each(["27,633 students", "27633 people", "27,633 kg"])(
    "refuses %s rather than guessing at the unit",
    (text) => {
      expect(failure(text)).toBe("unsupported-unit-syntax");
    },
  );

  it("refuses a leading currency symbol instead of dropping it", () => {
    // Only a TRAILING unit is recognised, so `$` lands in the numeric part and
    // fails there. The reason code differs from the trailing-unit case and the
    // property that matters does not: the number is refused rather than having
    // the symbol quietly stripped, which is how a dollar amount would otherwise
    // become a headcount.
    expect(failure("$27,633")).toBe("unparseable-number");
    expect(normalize("$27,633")).not.toMatchObject({ value: 27633 });
  });
});

describe("malformed numbers", () => {
  it.each(["", "abc", "27.", "1.2.3", "..", "%"])("refuses %s", (text) => {
    expect(isNormalizationFailure(normalize(text))).toBe(true);
  });
});

describe("the version is a value, not a comment", () => {
  it("is a non-empty string the candidate contract can compare against", () => {
    expect(NORMALIZATION_VERSION).toMatch(/^\S+$/u);
  });
});
