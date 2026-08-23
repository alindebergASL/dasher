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
 *
 * THIS LIST WAS RIVER-SHAPED, and the shape was invisible while the only
 * planner was a fake that never wrote a reading. Measured against the detector
 * before the air units below were added: "Sacramento at 12 ft" was caught, and
 * "Sacramento at 21 µg/m³", "21 ppb", "21 ppm", and "21 micrograms per cubic
 * meter" all passed into the dashboard's title. "20.6 µg/m³" was caught, but by
 * the bare-decimal rule underneath — the unit contributed nothing, so an
 * integer reading in air's own unit went through. A gate that holds for one
 * domain and not another is not a gate; it is a coincidence of which domain
 * shipped first.
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
  // Air quality. `µ` and `μ` are different codepoints that render alike, and a
  // model will produce either; both are listed rather than normalised, so what
  // the gate matches is what a reader would see.
  "µg/m³",
  "μg/m³",
  "µg/m3",
  "μg/m3",
  "ug/m³",
  "ug/m3",
  "micrograms per cubic meter",
  "micrograms per cubic metre",
  "microgram per cubic meter",
  "microgram per cubic metre",
  "ppm",
  "ppb",
  "%",
] as const;

const NUMBER = String.raw`\d{1,3}(?:,\d{3})+|\d+`;

/**
 * Spelled-out numbers, because the digit patterns below only ever saw ASCII.
 * "Sacramento at twelve feet" asserted a reading exactly as "12 ft" does, in the
 * same field, and passed the first eval sweep untouched. A model that has been
 * told not to write a number has an obvious next move, and the gate has to be
 * closed against the sentence rather than against the character class.
 *
 * Scale words are included so "three thousand cfs" reads as one quantity, and
 * `a`/`an` are excluded: "a foot of freeboard" is a unit of composition
 * language far more often than it is a claim about this river.
 */
const NUMBER_WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
  "twenty",
  "thirty",
  "forty",
  "fifty",
  "sixty",
  "seventy",
  "eighty",
  "ninety",
  "hundred",
  "thousand",
] as const;

const NUMBER_WORD = `(?:${NUMBER_WORDS.join("|")})`;

/**
 * An index whose number comes second: "AQI 84", "an AQI of 84".
 *
 * Every other unit is written after its number, so `QUANTITY` below reads
 * number-then-unit and cannot express this one. It earns a pattern of its own
 * rather than an exclusion, because AQI is a reading Dasher does not compute at
 * all — the air domain reports PM2.5 — so a plan stating one has invented it
 * outright rather than restating something already on the page.
 */
const INDEX_QUANTITY = new RegExp(
  String.raw`\bAQI\b(?:\s+of)?\s?[-–]?\s?(?:(?:${NUMBER})(?:\.\d+)?|${NUMBER_WORD}(?:[\s-]${NUMBER_WORD})*)`,
  "giu",
);

/**
 * A quantity: digits, then an optional space or hyphen, then a unit. Word units
 * are followed by a boundary, so "3 minutes" cannot read as three metres; `%`
 * needs no boundary because it is not a word character.
 */
/**
 * Units that end in a word character, so a trailing `\b` distinguishes "3
 * minutes" from three metres. The symbol-terminated units below cannot use one:
 * `%` and `µg/m³` do not end in a word character, and `\b` after them never
 * matches.
 */
const SYMBOL_TERMINATED = (unit: string): boolean => !/\w$/u.test(unit);

const WORD_UNITS = MEASUREMENT_UNITS.filter((unit) => !SYMBOL_TERMINATED(unit))
  .map(escape)
  .join("|");

const SYMBOL_UNITS = MEASUREMENT_UNITS.filter(SYMBOL_TERMINATED)
  .map(escape)
  .join("|");

const QUANTITY = new RegExp(
  String.raw`(?:${NUMBER})(?:\.\d+)?\s?[-–]?\s?(?:${WORD_UNITS})\b` +
    String.raw`|(?:${NUMBER})(?:\.\d+)?\s?(?:${SYMBOL_UNITS})` +
    // Spelled out: one or more number words, hyphen- or space-joined, then a
    // unit. "twenty-eight and a half feet" is not covered and is not pretended
    // to be; what is covered is the plain form a model actually reaches for.
    String.raw`|\b${NUMBER_WORD}(?:[\s-]${NUMBER_WORD})*\s?[-–]?\s?(?:${WORD_UNITS})\b`,
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
 *
 * THE SCOPE OF THIS LIST IS NOT ARBITRARY, which is what keeps it from being a
 * wordlist pretending to be a boundary. `anthropic.ts` tells the model:
 *
 *   > Never tell the reader to evacuate, seek higher ground, take shelter,
 *   > call emergency services, or avoid a road.
 *
 * The gate's job is to enforce exactly that sentence. The first eval sweep found
 * it enforcing only part of it: "Do not drive through flooded roads" was caught
 * while "Avoid flooded roads" passed, and the referral forms below passed
 * outright. A rule the prompt states and the gate does not check is the same
 * defect this whole change exists to remove, one layer down.
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

/**
 * The two forms the phrase list could not express, both drawn from what the
 * prompt forbids rather than from imagination.
 *
 * `ROAD_AVOIDANCE` — "avoid a road" in the shapes it actually gets written:
 * "avoid flooded roads", "avoid low-lying roads", "stay off the roads".
 *
 * `AUTHORITY_REFERRAL` — "call emergency services" generalised past the literal
 * 911. Sending a reader to emergency management for guidance is a safety
 * instruction with a redirect in front of it; Dasher has no more basis for it
 * than for the direct form. Observed verbatim in the first sweep: "Check your
 * local emergency management office or county flood control for guidance
 * specific to your area."
 */
// The intervening words allow hyphens: "avoid low-lying roads" is the same
// instruction as "avoid flooded roads", and `\w` does not span a hyphen.
const ROAD_AVOIDANCE = String.raw`\b(?:avoid|stay off)\b(?:\s+[\w-]+){0,3}\s+roads?\b`;

const AUTHORITY_REFERRAL =
  String.raw`\b(?:call|contact|check\s+with|check|consult|notify|follow)\b` +
  String.raw`(?:\s+[\w-]+){0,3}\s+` +
  String.raw`(?:emergency\s+(?:services|management|officials?)|` +
  String.raw`local\s+(?:authorities|officials)|` +
  String.raw`county\s+flood\s+control)\b`;

const DIRECTIVES = new RegExp(
  `\\b(?:${DIRECTIVE_PHRASES.map(escape).join("|")})\\b` +
    `|${ROAD_AVOIDANCE}` +
    `|${AUTHORITY_REFERRAL}`,
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
    const quantities = [
      ...matches(text, QUANTITY),
      ...matches(text, INDEX_QUANTITY),
    ];
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
