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
 *
 * FAIL CLOSED. A guard that quietly ignores what it cannot read is worse than
 * no guard, because it reports success either way. The first version of this
 * module skipped samples whose colours would not parse and skipped translucent
 * background layers instead of compositing them; both made it possible for a
 * real, visible regression to pass. Anything this cannot decide is now reported
 * as a problem, not dropped.
 */

/** Where a run of text came from. Inputs render text without owning a text node. */
export type SampleSource = "text" | "value" | "placeholder";

/** A run of text as the browser actually painted it. */
export interface RenderedText {
  /** Journey and viewport the sample came from, e.g. `river/390x844`. */
  readonly where: string;
  /** Enough of the element to find it again — class list or tag name. */
  readonly label: string;
  readonly text: string;
  /** Computed `color`, which may carry alpha. */
  readonly color: string;
  /**
   * Background layers in paint order, nearest painter first, ending with the
   * first fully opaque layer. Translucent layers are kept rather than skipped:
   * text on `rgba(0, 0, 0, 0.85)` is painted on near-black, not on whatever
   * shows through underneath.
   */
  readonly backgroundLayers: readonly string[];
  /**
   * Set when a layer paints something that cannot be reduced to one colour — a
   * gradient, an image. Guessing the effective colour of a gradient is exactly
   * the kind of approximation that makes a guard lie, so such a sample becomes
   * a reported problem instead.
   */
  readonly unsupportedPaint?: string;
  readonly fontSizePx: number;
  readonly fontWeight: number;
  readonly source: SampleSource;
}

export type ContrastProblem =
  | {
      readonly kind: "insufficient";
      readonly sample: RenderedText;
      readonly ratio: number;
      readonly required: number;
    }
  | {
      readonly kind: "unreadable";
      readonly sample: RenderedText;
      readonly detail: string;
    };

export type Rgb = readonly [number, number, number];

export interface ParsedColor {
  readonly rgb: Rgb;
  readonly alpha: number;
}

/**
 * Parses the `rgb()` / `rgba()` forms `getComputedStyle` returns. Deliberately
 * not a general CSS colour parser: computed styles are already normalised, so
 * accepting more would mean accepting inputs this never sees and cannot be
 * tested against honestly. Anything else returns undefined and becomes an
 * `unreadable` problem upstream rather than a silent skip.
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
 * Flattens a background stack into the single colour the text was painted on.
 *
 * Layers arrive nearest-first, so they are applied bottom-up: the opaque base
 * is painted first, then each nearer layer composited over the result. A stack
 * whose last layer is not opaque cannot be resolved — there is nothing
 * underneath it to composite onto — and says so rather than assuming white.
 */
export function resolveBackground(layers: readonly string[]): Rgb | string {
  if (layers.length === 0) {
    return "no background layer was captured";
  }
  const parsed: ParsedColor[] = [];
  for (const layer of layers) {
    const colour = parseCssColor(layer);
    if (colour === undefined) {
      return `background layer ${JSON.stringify(layer)} is not a colour this can read`;
    }
    parsed.push(colour);
  }
  const base = parsed[parsed.length - 1];
  if (base === undefined || base.alpha !== 1) {
    return "the furthest background layer is not opaque, so the painted colour is unknown";
  }
  let resolved: Rgb = base.rgb;
  for (let index = parsed.length - 2; index >= 0; index -= 1) {
    const layer = parsed[index];
    if (layer === undefined) {
      continue;
    }
    resolved = flatten(layer, resolved);
  }
  return resolved;
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
    if (sample.unsupportedPaint !== undefined) {
      problems.push({
        kind: "unreadable",
        sample,
        detail: sample.unsupportedPaint,
      });
      continue;
    }
    const foreground = parseCssColor(sample.color);
    if (foreground === undefined) {
      problems.push({
        kind: "unreadable",
        sample,
        detail: `foreground ${JSON.stringify(sample.color)} is not a colour this can read`,
      });
      continue;
    }
    const background = resolveBackground(sample.backgroundLayers);
    if (typeof background === "string") {
      problems.push({ kind: "unreadable", sample, detail: background });
      continue;
    }
    const ratio = contrastRatio(flatten(foreground, background), background);
    const required = requiredRatio(sample.fontSizePx, sample.fontWeight);
    if (ratio < required) {
      problems.push({ kind: "insufficient", sample, ratio, required });
    }
  }
  return problems;
}

export function describeContrastProblem(problem: ContrastProblem): string {
  const { sample } = problem;
  const where = [
    `${String(sample.fontSizePx)}px/${String(sample.fontWeight)}`,
    `at ${sample.where}`,
    `${sample.label} [${sample.source}] — ${JSON.stringify(sample.text)}`,
  ].join("  ");
  if (problem.kind === "unreadable") {
    return `UNREADABLE (${problem.detail})  ${where}`;
  }
  return [
    `${problem.ratio.toFixed(2)}:1 (needs ${String(problem.required)}:1)`,
    `${sample.color} on ${sample.backgroundLayers.join(" over ")}`,
    where,
  ].join("  ");
}
