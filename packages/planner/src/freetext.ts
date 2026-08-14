import type { DashboardPlan } from "./plan";

/**
 * The free-text hole in the plan contract, and the narrow gate over it.
 *
 * `plan.ts` used to say: "A model cannot assert a measurement through this
 * contract because there is nowhere in it to put one." That was false as
 * written. Five fields are free text and five fields reach the reader verbatim:
 *
 *   * `title`      → the dashboard's title
 *   * `audience`   → the dashboard's stated audience
 *   * `framing`    → the conditions-summary subtitle
 *   * `pages[].title`, `pages[].description` → the page headings
 *
 * The strict object stops a plan from carrying a `gaugeReadings` field. It does
 * nothing about a plan titled "Sacramento at 12.4 ft", which asserts a reading
 * just as effectively and renders in a larger font.
 *
 * WHAT THIS GATE COVERS, AND WHAT IT DOES NOT. Two categories, both deliberately
 * narrow:
 *
 *   * a MEASUREMENT — a quantity with a physical unit, or a decimal number. This
 *     is the category the contract's own docstring claimed was impossible, so it
 *     is the one made true here.
 *   * a DIRECTIVE — a short list of emergency imperatives. Dasher must not tell
 *     a reader to evacuate; it has no basis for that instruction and no evidence
 *     record that could support one.
 *
 * It does not attempt to catch a general claim. "Conditions are dangerous" is a
 * claim, is not caught, and a wordlist that tried would be a filter pretending
 * to be a boundary. The honest position is that free text is a judgement surface
 * with two hard edges, not a sanitized one; `packages/planner/eval/adversarial.ts`
 * measures what actually comes through so the next edge is drawn from evidence
 * rather than from imagination.
 *
 * These become `PlanFinding`s, so the first cost of a false positive is one
 * revision round-trip, not a rejected dashboard. That budget is what allows the
 * patterns to be a little eager.
 */

export type SmuggledTextKind = "measurement" | "directive";

export interface SmuggledText {
  kind: SmuggledTextKind;
  /** Dot path into the plan, e.g. `framing` or `pages[0].description`. */
  path: string;
  /** The exact substring that triggered it, for the revision message. */
  excerpt: string;
}

/**
 * Units that make a number a measurement. Two exclusions are deliberate:
 *
 *   * time windows — "24-hour change" and "the last 6 hours" are how a planner
 *     names a window, and a window is a composition choice, not a reading;
 *   * the bare units `in` and `m` — "Top 3 in the ranking" is ordinary
 *     composition language, and reading it as three inches would spend a
 *     revision round on a sentence that never asserted anything. The written-out
 *     forms are kept, and river stage is in feet regardless.
 */
const MEASUREMENT_UNITS = [
  "ft3/s",
  "ft³/s",
  "cfs",
  "cms",
  "ft",
  "feet",
  "foot",
  "inch",
  "inches",
  "meter",
  "meters",
  "metre",
  "metres",
  "mph",
  "kph",
  "%",
] as const;

const NUMBER = String.raw`\d{1,3}(?:,\d{3})+|\d+`;

/**
 * A quantity: digits, then an optional space or hyphen, then a unit. Word units
 * are followed by a boundary, so "3 minutes" cannot read as three metres; `%`
 * needs no boundary because it is not a word character.
 */
const QUANTITY = new RegExp(
  String.raw`(?:${NUMBER})(?:\.\d+)?\s?[-–]?\s?(?:` +
    MEASUREMENT_UNITS.filter((unit) => unit !== "%")
      .map(escape)
      .join("|") +
    String.raw`)\b|(?:${NUMBER})(?:\.\d+)?\s?%`,
  "giu",
);

/**
 * A bare decimal, with no unit attached. "12.4" in a sentence about a river is
 * a reading whether or not the planner wrote "ft" after it, and composition
 * language has no reason to carry a fractional number.
 */
const DECIMAL = new RegExp(String.raw`\b(?:${NUMBER})\.\d+\b`, "gu");

/**
 * Emergency imperatives, matched as phrases. The noun forms are excluded on
 * purpose: "Emergency management leads coordinating evacuations" is a fair
 * description of an audience, while "Evacuate now" is an instruction Dasher
 * cannot stand behind.
 */
const DIRECTIVE_PHRASES = [
  "evacuate",
  "seek higher ground",
  "move to higher ground",
  "get to higher ground",
  "take shelter",
  "shelter in place",
  "call 911",
  "dial 911",
  "turn around",
  "do not drive",
  "don't drive",
  "do not cross",
  "don't cross",
  "stay away from",
] as const;

const DIRECTIVES = new RegExp(
  `\\b(?:${DIRECTIVE_PHRASES.map(escape).join("|")})\\b`,
  "giu",
);

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/gu, String.raw`\$&`);
}

/** Every field of a plan whose text reaches the reader unchanged. */
export function planFreeText(
  plan: DashboardPlan,
): ReadonlyArray<{ path: string; text: string }> {
  return [
    { path: "title", text: plan.title },
    { path: "audience", text: plan.audience },
    { path: "framing", text: plan.framing },
    ...plan.pages.flatMap((page, index) => [
      { path: `pages[${index}].title`, text: page.title },
      { path: `pages[${index}].description`, text: page.description },
    ]),
  ];
}

function matches(text: string, pattern: RegExp): string[] {
  // The patterns are module-level and global, so each use starts a fresh
  // matcher rather than resuming from a previous field's `lastIndex`.
  return [...text.matchAll(new RegExp(pattern.source, pattern.flags))].map(
    (match) => match[0],
  );
}

export function findSmuggledText(plan: DashboardPlan): SmuggledText[] {
  const found: SmuggledText[] = [];

  for (const { path, text } of planFreeText(plan)) {
    const quantities = matches(text, QUANTITY);
    const decimals = matches(text, DECIMAL).filter(
      // A decimal inside a quantity is the same offence reported twice.
      (decimal) => !quantities.some((quantity) => quantity.includes(decimal)),
    );

    for (const excerpt of [...quantities, ...decimals]) {
      found.push({ kind: "measurement", path, excerpt });
    }
    for (const excerpt of matches(text, DIRECTIVES)) {
      found.push({ kind: "directive", path, excerpt });
    }
  }

  return found;
}

/**
 * Any digit at all, in any free-text field. Not a gate — a reporting hook for
 * the adversarial eval, which needs to see the near-misses the two hard edges
 * let through in order to decide where the next edge belongs.
 */
export function freeTextWithDigits(
  plan: DashboardPlan,
): ReadonlyArray<{ path: string; text: string }> {
  return planFreeText(plan).filter((field) => /\d/u.test(field.text));
}
