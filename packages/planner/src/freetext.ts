/**
 * The shape the gate reads, rather than one plan type it happens to have been
 * written against.
 *
 * `findSmuggledText` took `DashboardPlan`, so it could only ever run on station
 * plans. `LedgerPlanSchema` declares the same five reader-facing strings and was
 * not covered by anything — a gate typed to one source is a gate for one source.
 * Naming the fields it actually reads means a third plan contract is covered by
 * satisfying an interface rather than by someone remembering this file exists.
 */
export interface PlanFreeText {
  readonly title: string;
  readonly audience: string;
  readonly framing: string;
  readonly pages: readonly {
    readonly title: string;
    readonly description: string;
  }[];
}

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
 *   * a MEASUREMENT — a number written next to a unit, a pollutant, or an index
 *     name, in the shapes enumerated below.
 *   * a DIRECTIVE — a short list of emergency imperatives. Dasher must not tell
 *     a reader to evacuate; it has no basis for that instruction and no evidence
 *     record that could support one.
 *
 * THIS IS A DETECTOR, NOT A DECIDER, and the wording above was narrowed to say
 * so. It used to claim the measurement category was "made true here" and
 * describe the result as two "hard edges". Three rounds of review disproved
 * that, each by reading rather than by running anything: the first found air
 * units missing entirely, the second found `AQI: 84` and `PM2.5 at 21`, the
 * third found `PM2.5 was 21`, `twenty-one PM2.5` and `21 µg·m⁻³`. Every round
 * closed real holes. None of them could establish that the next round would
 * find nothing, because a pattern list cannot be complete over a natural
 * language and claiming otherwise invites exactly that loop.
 *
 * So the guarantee this file offers is bounded, and it is this: the enumerated
 * shapes below are caught, and each has a test. What protects a reader is not
 * this file alone — it is that every value on a rendered dashboard is computed
 * by Dasher from source observations, and nothing a planner writes in free text
 * is ever one of those values. This gate is defence in depth behind the
 * system prompt, which states the rule broadly on purpose, and behind that
 * arithmetic. It is not the reason a reader can trust a number.
 *
 * It does not attempt to catch a general claim. "Conditions are dangerous" is a
 * claim, is not caught, and a wordlist that tried would be a filter pretending
 * to be a boundary.
 *
 * WHERE THE NEXT SHAPE SHOULD COME FROM. `packages/planner/eval/adversarial.ts`
 * measures what a real model actually writes. It has never been run against the
 * air domain, so every air shape in this file was imagined by a reviewer rather
 * than observed. Adding more imagined shapes has a poor stopping rule; running
 * the eval has an obvious one.
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
  "micrograms/m³",
  "micrograms/m3",
  "parts per billion",
  "parts per million",
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
 * An index whose number usually comes second: "AQI 84", "AQI: 84", "AQI is 84",
 * "an AQI of 84", "84 AQI", "air quality index 84".
 *
 * Every other unit is written after its number, so `QUANTITY` below reads
 * number-then-unit and cannot express this one. It earns a pattern of its own
 * rather than a row in the unit list, because AQI is a reading Dasher does not
 * compute at all — the air domain reports PM2.5 — so a plan stating one has
 * invented it outright rather than restating something already on the page.
 *
 * THE VALUE IS ONE TO THREE DIGITS, and that bound is what keeps the pattern
 * from eating a year. The first version of this matched any number, so "AQI
 * 2024 reporting overview" — a perfectly ordinary title — was reported as a
 * smuggled reading. The index runs 0–500; a four-digit number after it is not
 * one.
 */
const INDEX_NAME = String.raw`(?:AQI|air[\s-]quality[\s-]index)`;
/** ":", "=", "is", "of", "at", or nothing at all. */
const INDEX_LINK = String.raw`(?:\s*[:=]\s*|\s+(?:is|of|at|was)\s+|\s*[-–]?\s*)`;
const INDEX_VALUE = String.raw`(?:\d{1,3}(?:\.\d+)?|${NUMBER_WORD}(?:[\s-]${NUMBER_WORD})*)`;

const INDEX_QUANTITY = new RegExp(
  String.raw`\b${INDEX_NAME}\b${INDEX_LINK}${INDEX_VALUE}\b` +
    String.raw`|\b${INDEX_VALUE}\s?\b${INDEX_NAME}\b`,
  "giu",
);

/**
 * A pollutant named, then its value, with no unit anywhere: "PM2.5 at 21".
 *
 * Dropping the unit is the cheapest way past a unit list, and it costs a reader
 * nothing — the pollutant already says what the number measures. Naming the
 * pollutant WITHOUT a value stays composition language and must keep passing:
 * "PM2.5 monitors near Sacramento" is what the air domain's own example request
 * says.
 */
const POLLUTANT = String.raw`(?:PM\s?-?\s?(?:2\.5|10)|ozone|NO2|SO2|CO2?)`;
/** ":", "=", a copula or preposition, or plain adjacency. */
const POLLUTANT_LINK = String.raw`(?:\s*[:=]\s*|\s+(?:is|was|are|were|of|at|reads|reading|measured)\s+|\s?[-–]?\s+)`;
/**
 * One to three digits, or the same number spelled out.
 *
 * The digit bound is doing the same job it does for the index above, and it was
 * missing here in the revision that introduced this pattern: bare adjacency
 * plus an unbounded number meant "PM2.5 2024 reporting overview" and "CO2 2024
 * monitoring plan" were reported as smuggled readings. A concentration in µg/m³
 * runs to three digits in the readings this product shows; a fourth is a year.
 *
 * Spelled numbers are here because the unit patterns already close that route —
 * "twenty-eight feet" has never passed — and a pollutant with a spelled value
 * asserts exactly as much as one with digits.
 */
const POLLUTANT_VALUE = String.raw`(?:\d{1,3}(?:\.\d+)?|${NUMBER_WORD}(?:[\s-]${NUMBER_WORD})*)`;
const POLLUTANT_READING = new RegExp(
  String.raw`\b${POLLUTANT}\b${POLLUTANT_LINK}${POLLUTANT_VALUE}\b` +
    String.raw`|\b${POLLUTANT_VALUE}\s?\b${POLLUTANT}\b`,
  "giu",
);

/**
 * A concentration written the way SI actually gets typed.
 *
 * The unit list holds literals, and literals cannot express optional whitespace
 * around a solidus or the middle-dot-and-negative-exponent form. All of these
 * are the same reading: `21 µg/m³`, `21 µg / m³`, `21 ug/m3`, `21 µg·m⁻³`. Both
 * micro signs are accepted for the reason the literal list gives, and `u` is
 * accepted because a plain-ASCII keyboard produces it.
 */
const MICRO = String.raw`[µμu]`;
const PER = String.raw`\s*[/·⋅.]\s*`;
const CUBIC_METRE = String.raw`m\s*(?:⁻³|³|\^-3|-3|3)`;
const CONCENTRATION = new RegExp(
  String.raw`(?:(?:${NUMBER})(?:\.\d+)?|${NUMBER_WORD}(?:[\s-]${NUMBER_WORD})*)` +
    String.raw`\s?[-–]?\s?${MICRO}g${PER}${CUBIC_METRE}`,
  "giu",
);

/**
 * Decimals that are not readings, and the reason each is here.
 *
 * The bare-decimal rule below is deliberately eager, and eagerness has a cost
 * that only shows up on real phrasing. Two costs were found in review:
 *
 *   * `PM 2.5` — the air domain's own pollutant, spelled with a space. Written
 *     `PM2.5` it passed, written `PM 2.5` it was reported. The same phrase
 *     cannot mean two things depending on a space.
 *   * `Version 2.5` — a version is not a measurement of anything on the page.
 *
 * Both are recognised here and excluded from the decimal sweep. Neither
 * exclusion reaches a number that follows them: `POLLUTANT_READING` above still
 * catches "PM 2.5 at 21".
 */
const NON_READING_DECIMAL = new RegExp(
  String.raw`\bPM\s?-?\s?(?:2\.5|10)\b` +
    String.raw`|\b(?:v|ver|version|revision|schema|spec)\.?\s?\d+\.\d+\b`,
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
 * Money, which the unit list cannot express and the ledger made unavoidable.
 *
 * `MEASUREMENT_UNITS` is read number-then-unit, and currency is the one quantity
 * routinely written the other way round: `$49,875` far more often than
 * `49,875 USD`. So it earns a pattern of its own, for the same reason `AQI 84`
 * did.
 *
 * WHY MONEY COUNTS AS A MEASUREMENT AT ALL. The rule the gate enforces is that
 * Dasher computes every figure itself from the source and the planner describes
 * the composition. On a ledger dashboard the figures ARE money, so an invented
 * dollar amount is not a lesser version of `21 µg/m³` — it is the same defect in
 * the domain where it matters most. Nothing about the rule was ever river-
 * specific; only the unit list was.
 *
 * WHAT IS DELIBERATELY EXCLUDED. A currency named without a value stays
 * composition language: "Amounts are in USD" tells a reader how to read the
 * dashboard and asserts nothing, exactly as "PM2.5 monitors near Sacramento"
 * does. Only a currency joined to a number is a reading.
 *
 * The code list is short on purpose rather than being ISO 4217 entire. That
 * register contains `ALL`, `TOP`, `CUP` and `BOB`, and matching all 180 codes
 * would report "ALL budget lines" as a smuggled amount. These are the codes a
 * planner writing about this product's ledger could plausibly reach for; a new
 * one is a one-line diff when a snapshot needs it.
 */
const CURRENCY_SYMBOL = String.raw`[$€£¥₹¢￥＄]`;
const CURRENCY_CODE = String.raw`(?:USD|EUR|GBP|JPY|CAD|AUD|CHF|SEK|NOK|DKK|NZD)`;
/**
 * A qualifier is optional and bounded to one word, because "49875 US dollars"
 * asserts exactly what "49875 dollars" does. Unbounded intervening words would
 * reach across a clause and start matching sentences that are not amounts.
 */
const CURRENCY_WORD = String.raw`(?:[A-Za-z]{2,3}\s)?(?:dollars?|euros?|pounds?|cents?|pence)`;
/**
 * `$1.2M`, `250k`, `3.5bn` — the scale letter is part of the amount, so leaving
 * it out would report `$1.2` and quote an excerpt that is not what was written.
 */
const SCALE_SUFFIX = String.raw`(?:\s?(?:k|m|bn|b))?`;
/** A sign belongs to the amount: `$-1,200` is a figure, not a symbol and a dash. */
const MONEY_NUMBER = String.raw`[-−]?(?:${NUMBER})(?:\.\d+)?`;
const SPELLED_NUMBER = String.raw`${NUMBER_WORD}(?:[\s-]${NUMBER_WORD})*`;

/**
 * A scaled amount with no currency marker at all: "250k in salaries".
 *
 * `k` and `bn` only, and the omissions are the point. A bare `m` is already
 * excluded from the unit list because "Top 3 in the ranking" is composition
 * language and three metres is not what it means; `b` collides with ordinary
 * section labels — "2b" — in the same way. So "$1.2M" is caught by the currency
 * pattern above, where the symbol supplies the missing evidence, while a bare
 * "1.2m" is left alone and said so here rather than quietly half-covered.
 */
const SCALED_AMOUNT = new RegExp(
  String.raw`\b(?:${NUMBER})(?:\.\d+)?\s?(?:k|bn)\b`,
  "giu",
);

const CURRENCY_QUANTITY = new RegExp(
  // $49,875 · £950 · $1.2M
  String.raw`${CURRENCY_SYMBOL}\s?${MONEY_NUMBER}${SCALE_SUFFIX}\b` +
    // USD 12,000
    String.raw`|\b${CURRENCY_CODE}\s?${MONEY_NUMBER}${SCALE_SUFFIX}\b` +
    // 49,875 USD · 1.2M USD
    String.raw`|\b${MONEY_NUMBER}${SCALE_SUFFIX}\s?${CURRENCY_CODE}\b` +
    // 12,000 dollars · twelve thousand dollars · 50 cents
    String.raw`|\b(?:${MONEY_NUMBER}|${SPELLED_NUMBER})\s?[-–]?\s?${CURRENCY_WORD}\b`,
  "giu",
);

/**
 * A comma-grouped integer, with no unit and no currency: "Total was 474,855".
 *
 * The bare-decimal rule below reasons that composition language has no reason to
 * carry a fractional number. The same is true of a grouped one, and leaving it
 * out was the largest hole in the money gate: the ledger dashboard's own total,
 * written without a currency, passed cleanly.
 *
 * ONLY THE GROUPED FORM. An ungrouped run of digits is not safe to read as a
 * magnitude here — `11446500` is a USGS site id, and a river plan naming one in
 * prose would be reported as a smuggled reading. The grouping separator is what
 * distinguishes a number written for a reader from an identifier, and a planner
 * that drops the commas to get past this is writing "474855", which the next
 * probe list should carry rather than this comment pretending otherwise.
 */
const GROUPED_INTEGER = new RegExp(String.raw`\b\d{1,3}(?:,\d{3})+\b`, "gu");

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
  plan: PlanFreeText,
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

/** A matched excerpt and where it sat, so overlaps can be resolved by position. */
export interface Span {
  readonly text: string;
  /** Inclusive. */
  readonly start: number;
  /** Exclusive, so two spans touch when one's `end` equals the other's `start`. */
  readonly end: number;
}

function matches(text: string, pattern: RegExp): Span[] {
  // The patterns are module-level and global, so each use starts a fresh
  // matcher rather than resuming from a previous field's `lastIndex`.
  return [...text.matchAll(new RegExp(pattern.source, pattern.flags))].map(
    (match) => ({
      text: match[0],
      start: match.index,
      end: match.index + match[0].length,
    }),
  );
}

/**
 * One offence, reported once.
 *
 * Several patterns now cover overlapping ground on purpose — "Ozone at 3 ppm"
 * is a pollutant reading AND a quantity, "20.6 µg/m³" is a quantity AND a bare
 * decimal — because each pattern exists to catch a shape the others miss. What
 * a reader must not get is the same phrase listed three times with three
 * different excerpts, which reads as three separate problems to repair.
 *
 * Overlap is resolved by position rather than by containment. Containment was
 * the previous rule and it only worked when one excerpt sat wholly inside
 * another; "Ozone at 3" and "3 ppm" overlap without either containing the
 * other, and both would have been reported.
 */
export function longestNonOverlapping(spans: readonly Span[]): Span[] {
  const byLengthThenPosition = [...spans].sort(
    (one, two) => two.text.length - one.text.length || one.start - two.start,
  );
  const kept: Span[] = [];
  for (const span of byLengthThenPosition) {
    const overlaps = kept.some(
      (other) => span.start < other.end && other.start < span.end,
    );
    if (!overlaps) kept.push(span);
  }
  return kept.sort((one, two) => one.start - two.start);
}

export function findSmuggledText(plan: PlanFreeText): SmuggledText[] {
  const found: SmuggledText[] = [];

  for (const { path, text } of planFreeText(plan)) {
    // Spelled-out names that are not readings — the domain's own pollutant, a
    // version string — are found first and used to mask the decimal sweep.
    const excluded = matches(text, NON_READING_DECIMAL);
    // Both halves are load-bearing. Checking only "ends inside" would let an
    // exclusion appearing LATER in the field swallow an earlier real reading —
    // "Readings of 12.4 across PM 2.5 monitors" — which is a test below.
    //
    // The `>=` never fires on equality: an exclusion match begins with a letter
    // and a decimal match with a digit, so the two cannot start at the same
    // index. Searching 279,841 generated strings over these two patterns found
    // no case where relaxing it to `>` changed the answer, which is why the
    // mutation gate reports one survivor here and it is left standing.
    const inExcluded = (span: Span): boolean =>
      excluded.some((one) => span.start >= one.start && span.end <= one.end);

    const measurements = longestNonOverlapping([
      ...matches(text, QUANTITY),
      ...matches(text, INDEX_QUANTITY),
      ...matches(text, POLLUTANT_READING),
      ...matches(text, CONCENTRATION),
      ...matches(text, CURRENCY_QUANTITY),
      ...matches(text, SCALED_AMOUNT),
      ...matches(text, GROUPED_INTEGER),
      ...matches(text, DECIMAL).filter((decimal) => !inExcluded(decimal)),
    ]);

    for (const span of measurements) {
      found.push({ kind: "measurement", path, excerpt: span.text });
    }
    for (const span of matches(text, DIRECTIVES)) {
      found.push({ kind: "directive", path, excerpt: span.text });
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
  plan: PlanFreeText,
): ReadonlyArray<{ path: string; text: string }> {
  return planFreeText(plan).filter((field) => /\d/u.test(field.text));
}
