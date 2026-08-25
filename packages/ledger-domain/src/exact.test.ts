import { describe, expect, it } from "vitest";

import {
  ZERO,
  abs,
  add,
  compare,
  fromEngineDecimal,
  fromNumber,
  fromParts,
  ratioToPercent,
  round,
  sign,
  subtract,
  toFixed,
} from "./exact";

/**
 * The arithmetic every ledger figure now passes through.
 *
 * The cases below are chosen against the failures a decimal-as-text
 * representation actually has — a sign that survives a zero result, a scale
 * that has to be aligned before two values can be compared, a rounding rule
 * that is not the one JavaScript gives away free — rather than against a list
 * of operations.
 *
 * THE MUTATION SURVIVORS WERE TRACED RATHER THAN DISMISSED, which is the whole
 * reason two of the cases here exist. Eight mutants survived the first version.
 * Two were real gaps and are now covered: `/[1-9]/` flipped to `/[^1-9]/` drops
 * the minus from a negative that reduces to a whole number, reachable through
 * `subtract("1.5", "2.5")`; and `"0".repeat` emptied stops `toFixed` padding a
 * fraction shorter than the width asked for. One was an unasserted error
 * message. Score went 93.70% to 96.06%.
 *
 * The five that remain are equivalent, and here is the reason for each rather
 * than the assertion that they are:
 *
 *   * `if (scale === 0) return units.toString(10)` removed — the fast path is a
 *     pure optimisation; at scale 0 the general path takes all digits as the
 *     whole part and an empty fraction, producing the same text.
 *   * `units < 0n` → `<= 0n` in `fromParts` — differs only at zero, where the
 *     body renders as "0" and the sign guard drops the minus regardless.
 *   * `one.scale >= 2` → `> 2` in `ratioToPercent` — at exactly 2 the other
 *     branch multiplies by `10 ** 0`, which is the same call.
 *   * `one.scale <= places` → `<` in `round` — at equality the general path
 *     divides by `10 ** 0` with a zero remainder and returns the input.
 *   * `one.units < 0n` → `<= 0n` in `round` — differs only at zero, where the
 *     magnitude is zero and `fromParts(-0n, places)` renders "0".
 *
 * The last time survivors in this repository were called equivalent without
 * being traced, the claim was wrong and disproving it took 2,208 differences
 * over 14,739 generated strings.
 */

describe("canonical form", () => {
  it.each([
    [0n, 0, "0"],
    [49875n, 0, "49875"],
    [-4600n, 0, "-4600"],
    [6662881571n, 10, "0.6662881571"],
    [1230n, 2, "12.3"],
    [100n, 2, "1"],
    // The sign has to survive a negative that reduces to a whole number. The
    // guard against `-0` is a test on the rendered body, and every body it had
    // ever been given contained a "." or a digit outside 1-9; one that does not
    // — "1", from -100 scaled by 2 — is the case where a wrong guard drops the
    // minus and reports a fall as a rise.
    [-100n, 2, "-1"],
    [-500n, 3, "-0.5"],
  ])("renders %s scaled by %i as %j", (units, scale, expected) => {
    expect(fromParts(units, scale)).toBe(expected);
  });

  it("never produces a negative zero", () => {
    // `-0` is a value JavaScript has and money does not. Two results that are
    // equal must also be the same text, or a `toBe` comparison starts lying.
    expect(fromParts(-0n, 0)).toBe("0");
    expect(fromParts(-0n, 4)).toBe("0");
    expect(subtract("5", "5")).toBe("0");
    expect(subtract("0.5", "0.5")).toBe("0");
  });
});

describe("reading a value in", () => {
  it("reads the engine's wire form", () => {
    expect(
      fromEngineDecimal({ coefficient: "6662881571", scale: "i64:10" }),
    ).toBe("0.6662881571");
  });

  it("reads a JSON number as the decimal that was written", () => {
    expect(fromNumber(49875)).toBe("49875");
    expect(fromNumber(1234.56)).toBe("1234.56");
    expect(fromNumber(-0.5)).toBe("-0.5");
    expect(fromNumber(0)).toBe("0");
  });

  it("refuses rather than approximates what it cannot carry", () => {
    // `toString` switches to exponent notation at these magnitudes, and the
    // decimal grammar below it does not accept one. Refusing is the point: a
    // silent approximation here would be the original defect, moved.
    // The message names the value, so a reader of the failure knows which
    // amount was refused rather than only that one was.
    expect(() => fromNumber(1e21)).toThrow(/1e\+21 is not a decimal/u);
    expect(() => fromNumber(1e21)).toThrow(RangeError);
    expect(() => fromNumber(1e-7)).toThrow(RangeError);
    expect(() => fromNumber(Number.NaN)).toThrow(RangeError);
    expect(() => fromNumber(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe("arithmetic that does not drift", () => {
  it("adds values of unlike scale by aligning them first", () => {
    expect(add("0.1", "0.2")).toBe("0.3");
    expect(add("49875", "0.25")).toBe("49875.25");
    expect(add("1.5", "-1.25")).toBe("0.25");
  });

  it("keeps the sign when a subtraction lands on a whole number", () => {
    // The reachable route to the case above: aligning 1.5 and 2.5 gives -10
    // scaled by 1, whose body renders as "1" with nothing but the sign guard to
    // say it is negative.
    expect(subtract("1.5", "2.5")).toBe("-1");
    expect(subtract("2.5", "1.5")).toBe("1");
  });

  it("sums a hundred hundredths to exactly one", () => {
    // The float version of this sum is 1.0000000000000007.
    let total = ZERO;
    for (let index = 0; index < 100; index += 1) total = add(total, "0.01");

    expect(total).toBe("1");
  });

  it("orders by value, not by text", () => {
    // "9" sorts after "10" as text and before it as a number.
    expect(compare("9", "10")).toBe(-1);
    expect(compare("0.30", "0.3")).toBe(0);
    expect(compare("-4600", "-350")).toBe(-1);
  });

  it("reports a sign without arithmetic", () => {
    expect(sign("-0.0001")).toBe(-1);
    expect(sign("0")).toBe(0);
    expect(sign("0.0001")).toBe(1);
  });

  it("takes a magnitude", () => {
    expect(abs("-4600")).toBe("4600");
    expect(abs("4600")).toBe("4600");
    expect(abs("0")).toBe("0");
  });
});

describe("percentages and display", () => {
  it("moves the point rather than multiplying", () => {
    expect(ratioToPercent("0.6662881571")).toBe("66.62881571");
    expect(ratioToPercent("1")).toBe("100");
    expect(ratioToPercent("0")).toBe("0");
    // A ratio with fewer than two decimals still has to grow, not shrink.
    expect(ratioToPercent("0.5")).toBe("50");
  });

  it("rounds half away from zero, in both directions", () => {
    // Half-away rather than half-even, because this is the last step before a
    // reader sees it and +7.5 reading as +8 is what a person expects.
    expect(round("7.65", 1)).toBe("7.7");
    expect(round("-7.65", 1)).toBe("-7.7");
    expect(round("7.64", 1)).toBe("7.6");
    expect(round("0.05", 1)).toBe("0.1");
  });

  it("leaves a value alone when it is already shorter", () => {
    expect(round("7.6", 4)).toBe("7.6");
    expect(round("8", 2)).toBe("8");
  });

  it("pads to a fixed width so a column lines up", () => {
    expect(toFixed("7.6", 1)).toBe("7.6");
    expect(toFixed("8", 1)).toBe("8.0");
    expect(toFixed("8", 0)).toBe("8");
    // Padding a fraction that is shorter than the width asked for. Every case
    // above either had the exact width already or no decimal point at all, so
    // the padding itself was never run with anything to add.
    expect(toFixed("7.6", 2)).toBe("7.60");
    expect(toFixed("-1.5", 3)).toBe("-1.500");
    // Rounds to nothing, and shows as a plain zero rather than "-0.0": the
    // sign is dropped when the magnitude is, so a reader is never shown a
    // negative zero.
    expect(toFixed("-0.04", 1)).toBe("0.0");
  });
});
