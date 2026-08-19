/**
 * WCAG 2.1 contrast, decided over samples taken from a rendered page.
 *
 * This exists because a stylesheet cannot be read for this. PR #34 introduced
 * a contrast regression that survived review of the hex values themselves:
 * `--muted` looked like a reasonable grey, and it was — on white. It failed on
 * all six tinted surfaces the product actually paints it on. The only way to
 * know is to ask a browser what it rendered and against what.
 *
 * So the split here is deliberate. Collecting samples needs a real page and
 * lives in the Playwright spec; deciding whether a sample passes is arithmetic
 * and lives here, where unit tests can pin it against published WCAG values.
 * The same division `@dasher/repo-graph` uses for the Playwright report.
 *
 * Like that module, this reports *every* problem rather than the first. A
 * palette change breaks pairs in groups, and being told about one of eleven
 * turns one fix into eleven rounds.
 */

/** A run of text as the browser actually painted it. */
export interface RenderedText {
  /** Journey and viewport the sample came from, e.g. `river/390x844`. */
  readonly where: string;
  /** Enough of the element to find it again — class list or tag name. */
  readonly label: string;
  readonly text: string;
  /** Computed `color`, which may carry alpha. */
  readonly color: string;
  /** Effective background, resolved through transparent ancestors. Opaque. */
  readonly background: string;
  readonly fontSizePx: number;
  readonly fontWeight: number;
}

export interface ContrastProblem {
  readonly sample: RenderedText;
  readonly ratio: number;
  readonly required: number;
}

export type Rgb = readonly [number, number, number];

interface ParsedColor {
  readonly rgb: Rgb;
  readonly alpha: number;
}

/**
 * Parses the `rgb()` / `rgba()` forms `getComputedStyle` returns. Deliberately
 * not a general CSS colour parser: computed styles are already normalised, so
 * accepting more would mean accepting inputs this never sees and cannot be
 * tested against honestly.
 */
export function parseCssColor(value: string): ParsedColor | undefined {
  const match = /^rgba?\(([^)]+)\)$/u.exec(value.trim());
  const body = match?.[1];
  if (body === undefined) {
    return undefined;
  }
  const parts = body
    .split(/[,\s/]+/u)
    .filter((part) => part.length > 0)
    .map(Number);
  const [red, green, blue, maybeAlpha] = parts;
  if (
    red === undefined ||
    green === undefined ||
    blue === undefined ||
    !Number.isFinite(red) ||
    !Number.isFinite(green) ||
    !Number.isFinite(blue)
  ) {
    return undefined;
  }
  const alpha =
    maybeAlpha !== undefined && Number.isFinite(maybeAlpha) ? maybeAlpha : 1;
  return { rgb: [red, green, blue], alpha };
}

function channelLuminance(value: number): number {
  const scaled = value / 255;
  return scaled <= 0.03928
    ? scaled / 12.92
    : Math.pow((scaled + 0.055) / 1.055, 2.4);
}

export function relativeLuminance(rgb: Rgb): number {
  return (
    0.2126 * channelLuminance(rgb[0]) +
    0.7152 * channelLuminance(rgb[1]) +
    0.0722 * channelLuminance(rgb[2])
  );
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Composites a possibly-translucent foreground onto an opaque background. */
export function flatten(foreground: ParsedColor, background: Rgb): Rgb {
  const mix = (over: number, under: number): number =>
    over * foreground.alpha + under * (1 - foreground.alpha);
  return [
    mix(foreground.rgb[0], background[0]),
    mix(foreground.rgb[1], background[1]),
    mix(foreground.rgb[2], background[2]),
  ];
}

/**
 * WCAG AA: 3:1 for large text, 4.5:1 otherwise. Large is 18pt (24px), or 14pt
 * (18.66px) when bold. The weight threshold matters — the labels this product
 * sets at 600 are *not* bold enough to qualify at any size below 24px.
 */
export function requiredRatio(fontSizePx: number, fontWeight: number): number {
  const large = fontSizePx >= 24 || (fontSizePx >= 18.66 && fontWeight >= 700);
  return large ? 3 : 4.5;
}

export function findContrastProblems(
  samples: readonly RenderedText[],
): readonly ContrastProblem[] {
  const problems: ContrastProblem[] = [];
  for (const sample of samples) {
    const foreground = parseCssColor(sample.color);
    const background = parseCssColor(sample.background);
    if (foreground === undefined || background === undefined) {
      continue;
    }
    const ratio = contrastRatio(
      flatten(foreground, background.rgb),
      background.rgb,
    );
    const required = requiredRatio(sample.fontSizePx, sample.fontWeight);
    if (ratio < required) {
      problems.push({ sample, ratio, required });
    }
  }
  return problems;
}

export function describeContrastProblem(problem: ContrastProblem): string {
  const { sample, ratio, required } = problem;
  return [
    `${ratio.toFixed(2)}:1 (needs ${String(required)}:1)`,
    `${String(sample.fontSizePx)}px/${String(sample.fontWeight)}`,
    `${sample.color} on ${sample.background}`,
    `at ${sample.where}`,
    `${sample.label} — ${JSON.stringify(sample.text)}`,
  ].join("  ");
}
