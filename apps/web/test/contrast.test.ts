import { describe, expect, it } from "vitest";

import {
  contrastRatio,
  describeContrastProblem,
  findContrastProblems,
  flatten,
  parseCssColor,
  relativeLuminance,
  requiredRatio,
  type RenderedText,
} from "./contrast";

const sample = (overrides: Partial<RenderedText> = {}): RenderedText => ({
  where: "river/1440x1100",
  label: ".eyebrow",
  text: "Overview",
  color: "rgb(97, 111, 106)",
  background: "rgb(247, 245, 242)",
  fontSizePx: 11,
  fontWeight: 600,
  ...overrides,
});

describe("contrastRatio", () => {
  // Published anchors. If the sRGB linearisation is wrong these move, and no
  // amount of testing our own tokens against themselves would notice.
  it("is 21 for black on white", () => {
    expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 10);
  });

  it("is 1 for a colour against itself", () => {
    expect(contrastRatio([18, 52, 86], [18, 52, 86])).toBeCloseTo(1, 10);
  });

  it("is symmetric", () => {
    const forward = contrastRatio([97, 111, 106], [247, 245, 242]);
    const backward = contrastRatio([247, 245, 242], [97, 111, 106]);
    expect(forward).toBeCloseTo(backward, 10);
  });

  // #767676 is the canonical lightest grey that clears AA on white, and #777777
  // is the canonical one that just misses. A rounding error in either direction
  // shows up here before it shows up in a palette.
  it("puts #767676 just above and #777777 just below the 4.5 floor on white", () => {
    const white: [number, number, number] = [255, 255, 255];
    expect(contrastRatio([0x76, 0x76, 0x76], white)).toBeGreaterThanOrEqual(
      4.5,
    );
    expect(contrastRatio([0x77, 0x77, 0x77], white)).toBeLessThan(4.5);
  });
});

describe("relativeLuminance", () => {
  it("is 0 for black and 1 for white", () => {
    expect(relativeLuminance([0, 0, 0])).toBeCloseTo(0, 10);
    expect(relativeLuminance([255, 255, 255])).toBeCloseTo(1, 10);
  });

  it("weights green above red above blue", () => {
    const red = relativeLuminance([255, 0, 0]);
    const green = relativeLuminance([0, 255, 0]);
    const blue = relativeLuminance([0, 0, 255]);
    expect(green).toBeGreaterThan(red);
    expect(red).toBeGreaterThan(blue);
  });
});

describe("parseCssColor", () => {
  it("reads the rgb and rgba forms computed styles return", () => {
    expect(parseCssColor("rgb(97, 111, 106)")).toEqual({
      rgb: [97, 111, 106],
      alpha: 1,
    });
    expect(parseCssColor("rgba(20, 32, 28, 0.5)")).toEqual({
      rgb: [20, 32, 28],
      alpha: 0.5,
    });
  });

  it("reads the space-and-slash form", () => {
    expect(parseCssColor("rgb(20 32 28 / 0.25)")).toEqual({
      rgb: [20, 32, 28],
      alpha: 0.25,
    });
  });

  it("returns undefined for anything else", () => {
    expect(parseCssColor("transparent")).toBeUndefined();
    expect(parseCssColor("#616f6a")).toBeUndefined();
    expect(parseCssColor("rgb(1, 2)")).toBeUndefined();
  });
});

describe("flatten", () => {
  it("returns the foreground unchanged when it is opaque", () => {
    expect(flatten({ rgb: [10, 20, 30], alpha: 1 }, [255, 255, 255])).toEqual([
      10, 20, 30,
    ]);
  });

  it("returns the background when the foreground is fully transparent", () => {
    expect(flatten({ rgb: [10, 20, 30], alpha: 0 }, [200, 210, 220])).toEqual([
      200, 210, 220,
    ]);
  });

  // Half-transparent ink is lighter than it looks in the stylesheet, so a pair
  // that passes on its hex values can still fail on screen.
  it("mixes proportionally at partial alpha", () => {
    expect(flatten({ rgb: [0, 0, 0], alpha: 0.5 }, [255, 255, 255])).toEqual([
      127.5, 127.5, 127.5,
    ]);
  });
});

describe("requiredRatio", () => {
  it("requires 4.5 for normal text", () => {
    expect(requiredRatio(15, 400)).toBe(4.5);
    // Just under 24px and not bold: still normal text, however close it looks.
    expect(requiredRatio(23.9, 400)).toBe(4.5);
    // Bold but below the 18.66px bold threshold.
    expect(requiredRatio(18, 700)).toBe(4.5);
  });

  it("requires 3 for 24px and above at any weight", () => {
    expect(requiredRatio(24, 400)).toBe(3);
    expect(requiredRatio(46, 600)).toBe(3);
  });

  it("requires 3 from 18.66px only when actually bold", () => {
    expect(requiredRatio(18.66, 700)).toBe(3);
    // The product sets its labels at 600. That is not bold enough to qualify,
    // and treating it as though it were would license a 3:1 label.
    expect(requiredRatio(18.66, 600)).toBe(4.5);
  });
});

describe("findContrastProblems", () => {
  it("accepts a pair that clears its floor", () => {
    expect(findContrastProblems([sample()])).toEqual([]);
  });

  it("reports a pair that misses its floor", () => {
    // The exact regression this guard exists for: the previous --muted on the
    // warm canvas, which measured 4.14:1.
    const problems = findContrastProblems([
      sample({ color: "rgb(107, 122, 117)" }),
    ]);
    expect(problems).toHaveLength(1);
    const [problem] = problems;
    expect(problem?.ratio).toBeLessThan(4.5);
    expect(problem?.required).toBe(4.5);
  });

  it("reports every problem, not the first", () => {
    const problems = findContrastProblems([
      sample({ color: "rgb(107, 122, 117)", label: "a" }),
      sample({ color: "rgb(148, 160, 155)", label: "b" }),
      sample({ label: "c" }),
      sample({ color: "rgb(138, 160, 152)", label: "d" }),
    ]);
    expect(problems.map((problem) => problem.sample.label)).toEqual([
      "a",
      "b",
      "d",
    ]);
  });

  it("holds large text to 3:1 rather than 4.5:1", () => {
    const display = {
      fontSizePx: 34,
      fontWeight: 600,
      color: "rgb(120, 130, 125)",
    };
    expect(findContrastProblems([sample(display)])).toEqual([]);
    expect(
      findContrastProblems([sample({ ...display, fontSizePx: 15 })]),
    ).toHaveLength(1);
  });

  it("accounts for foreground alpha rather than the declared colour", () => {
    // Opaque ink that passes, then the same ink at 40% — which does not.
    expect(
      findContrastProblems([sample({ color: "rgb(20, 32, 28)" })]),
    ).toEqual([]);
    expect(
      findContrastProblems([sample({ color: "rgba(20, 32, 28, 0.4)" })]),
    ).toHaveLength(1);
  });

  it("skips samples whose colours it cannot read rather than inventing a verdict", () => {
    expect(
      findContrastProblems([
        sample({ color: "color(display-p3 0.1 0.2 0.3)" }),
        sample({ background: "transparent" }),
      ]),
    ).toEqual([]);
  });
});

describe("describeContrastProblem", () => {
  it("names the ratio, the floor, the pair, and where it was seen", () => {
    const [problem] = findContrastProblems([
      sample({ color: "rgb(107, 122, 117)" }),
    ]);
    if (problem === undefined) {
      throw new Error("expected the low-contrast sample to be reported");
    }
    const described = describeContrastProblem(problem);
    expect(described).toContain("4.14:1");
    expect(described).toContain("needs 4.5:1");
    expect(described).toContain("rgb(107, 122, 117) on rgb(247, 245, 242)");
    expect(described).toContain("river/1440x1100");
    expect(described).toContain(".eyebrow");
    expect(described).toContain("Overview");
  });
});
