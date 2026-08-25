import { describe, expect, it } from "vitest";

import {
  findSmuggledText,
  freeTextWithDigits,
  longestNonOverlapping,
  planFreeText,
} from "./freetext";
import type { DashboardPlan } from "./plan";

const base: DashboardPlan = {
  planVersion: "plan-v1",
  title: "Sacramento River Conditions",
  audience: "Managers and community leaders",
  framing: "What is happening now, what changed, and what deserves attention.",
  siteIds: ["11446500"],
  pages: [
    {
      id: "overview",
      title: "Overview",
      description: "Current conditions and what deserves attention.",
      sections: ["conditions-summary", "gauge-table"],
    },
  ],
};

function withText(field: Partial<DashboardPlan>): DashboardPlan {
  return { ...base, ...field };
}

describe("planFreeText", () => {
  it("covers every field that reaches the reader verbatim", () => {
    // If `compilePlan` starts rendering a sixth plan string, this list has to
    // grow with it. The count is pinned so adding one silently fails here
    // rather than quietly opening a sixth unchecked surface.
    expect(planFreeText(base).map((field) => field.path)).toStrictEqual([
      "title",
      "audience",
      "framing",
      "pages[0].title",
      "pages[0].description",
    ]);
  });

  it("walks every page, not just the first", () => {
    const twoPages = withText({
      pages: [base.pages[0]!, { ...base.pages[0]!, id: "second" }],
    });

    expect(planFreeText(twoPages).map((field) => field.path)).toContain(
      "pages[1].description",
    );
  });
});

describe("findSmuggledText: measurements", () => {
  it("passes composition language that asserts nothing", () => {
    expect(findSmuggledText(base)).toStrictEqual([]);
  });

  it.each([
    ["a stage reading with a unit", "Sacramento at 12.4 ft"],
    ["a whole number with a unit", "The river rose 3 feet"],
    ["a streamflow reading", "Flowing at 3,200 cfs right now"],
    ["the schema's own unit spelling", "Peaking near 18000 ft3/s"],
    ["a hyphenated quantity", "A 6-foot rise since morning"],
    ["a percentage", "Running 40% above normal"],
    ["a bare decimal with no unit", "The gauge reads 12.4 this morning"],
  ])("catches %s", (_label, title) => {
    const found = findSmuggledText(withText({ title }));

    expect(found.map((item) => item.kind)).toContain("measurement");
    expect(found[0]?.path).toBe("title");
  });

  it.each([
    ["a time window", "Change over the last 24 hours"],
    ["a hyphenated time window", "The 24-hour view"],
    ["a short window", "Movement in the last 6 hours"],
    ["an ordinal count", "The top 3 gauges by rate of change"],
    ["a count with a preposition", "Top 3 in the ranking"],
    ["a bare year", "Conditions since 2024"],
  ])("does not fire on %s", (_label, framing) => {
    expect(findSmuggledText(withText({ framing }))).toStrictEqual([]);
  });

  it("reports a measurement in a page description, with its path", () => {
    const found = findSmuggledText(
      withText({
        pages: [{ ...base.pages[0]!, description: "Currently 14.2 ft." }],
      }),
    );

    expect(found).toStrictEqual([
      { kind: "measurement", path: "pages[0].description", excerpt: "14.2 ft" },
    ]);
  });

  it("reports a decimal once, not twice, when it already carries a unit", () => {
    // The decimal pattern and the quantity pattern both see "12.4 ft". One
    // offence, one finding — otherwise the revision message reads as two.
    const found = findSmuggledText(withText({ title: "Reading 12.4 ft" }));

    expect(found).toHaveLength(1);
    expect(found[0]?.excerpt).toBe("12.4 ft");
  });

  it("reports every field that carries one", () => {
    const found = findSmuggledText(
      withText({ title: "At 12.4 ft", framing: "Flowing at 3,200 cfs." }),
    );

    expect(found.map((item) => item.path)).toStrictEqual(["title", "framing"]);
  });

  it("does not resume mid-string between fields", () => {
    // The patterns are global. A shared matcher would carry `lastIndex` from
    // one field into the next and skip the beginning of it, which is the kind
    // of miss that looks like a clean plan.
    const found = findSmuggledText(
      withText({
        title: "A very long title mentioning nothing measurable whatsoever",
        audience: "9 ft",
      }),
    );

    expect(found.map((item) => item.path)).toStrictEqual(["audience"]);
  });
});

describe("findSmuggledText: air-quality measurements", () => {
  /**
   * The unit list was river-shaped, and nothing noticed because the only
   * planner was a fake that never wrote a reading. Every title below reached
   * the reader untouched before the air units were added; each is a reading
   * Dasher computes and displays elsewhere, asserted in the one place it has
   * no evidence record behind it.
   */
  it.each([
    ["a PM2.5 reading", "Sacramento at 21 µg/m³"],
    // Two codepoints render as the same glyph, and a model writes either.
    ["the other micro sign", "Sacramento at 21 μg/m³"],
    ["the ASCII spelling", "Sacramento at 21 ug/m3"],
    [
      "a written-out concentration",
      "Sacramento at 21 micrograms per cubic meter",
    ],
    ["parts per billion", "Ozone at 41 ppb"],
    ["parts per million", "Ozone at 3 ppm"],
  ])("catches %s", (_label, title) => {
    const found = findSmuggledText(withText({ title }));

    expect(found.map((item) => item.kind)).toContain("measurement");
    expect(found[0]?.path).toBe("title");
  });

  /**
   * AQI is not merely a reading restated — Dasher never computes one. The air
   * domain reports PM2.5, so a plan that states an index has invented a number
   * outright. Its number also comes second, which is why it needs a pattern of
   * its own rather than a row in the unit list.
   */
  it.each([
    ["an index reading", "Sacramento AQI 84"],
    ["an index with a preposition", "Sacramento, an AQI of 84"],
    ["an index written out", "Sacramento at an AQI of eighty-four"],
  ])("catches %s", (_label, title) => {
    expect(
      findSmuggledText(withText({ title })).map((item) => item.kind),
    ).toContain("measurement");
  });

  it.each([
    ["the domain's own subject", "Air quality across Sacramento"],
    ["the pollutant named without a value", "PM2.5 monitors near Sacramento"],
    ["a monitor count", "Top 3 monitors by one-hour rise"],
    ["a window", "PM2.5 movement over the last 24 hours"],
  ])("does not fire on %s", (_label, framing) => {
    expect(findSmuggledText(withText({ framing }))).toStrictEqual([]);
  });

  /**
   * Every case below reached the reader's title on
   * `e3a8d5dd2b79a57b0e10e5d148e2030551cb7f68`, the head that closed the unit
   * list. Adding air units caught the shapes that name a unit; these are the
   * shapes that do not need one — ordinary punctuation, a copula, the reversed
   * order, the written-out index name, and a pollutant whose value carries no
   * unit at all because the pollutant already says what is being measured.
   */
  it.each([
    ["a colon", "Sacramento AQI: 84"],
    ["a copula", "Sacramento AQI is 84"],
    ["an equals sign", "Sacramento AQI = 84"],
    ["the reversed order", "Sacramento at 84 AQI"],
    ["the written-out name", "Air quality index 84"],
    ["the written-out name with a preposition", "Air quality index of 84"],
  ])("catches an index reading written with %s", (_label, title) => {
    expect(
      findSmuggledText(withText({ title })).map((item) => item.kind),
    ).toContain("measurement");
  });

  it.each([
    ["no unit at all", "Sacramento PM2.5 at 21"],
    ["a slashed unit", "Sacramento PM2.5 at 21 micrograms/m3"],
    ["a written-out unit", "Sacramento PM2.5 at 21 parts per billion"],
    ["a spaced pollutant name", "Sacramento PM 2.5 at 21"],
    ["a colon", "Sacramento PM2.5: 21"],
  ])("catches a pollutant reading written with %s", (_label, title) => {
    expect(
      findSmuggledText(withText({ title })).map((item) => item.kind),
    ).toContain("measurement");
  });

  /**
   * The other half of the same review. Each of these was a FALSE POSITIVE on
   * that head: the first AQI pattern matched any number, so it ate a year, and
   * the bare-decimal rule fired on the air domain's own pollutant whenever it
   * was written with a space — so `PM2.5 monitors` passed while `PM 2.5
   * monitors` did not, which is the same phrase treated two ways.
   */
  it.each([
    ["the pollutant spelled with a space", "PM 2.5 monitors"],
    ["a year after the index name", "AQI 2024 reporting overview"],
    ["a version number", "Version 2.5 layout"],
    ["the index named without a value", "Air quality index overview"],
    ["the index named in a trend", "AQI trends this season"],
    ["the pollutant named without a value", "PM2.5 monitors near Sacramento"],
  ])("does not fire on %s", (_label, title) => {
    expect(findSmuggledText(withText({ title }))).toStrictEqual([]);
  });

  /**
   * A second review pass over the same family. Adding the connector list and a
   * digit value closed the shapes a model reaches for first; these are the
   * neighbours of those shapes, and each reached the reader's title on
   * `40af3bf138925f3933283d7c13cfbe708021c713`.
   *
   * "was" was simply missing from a connector list I wrote. The spelled forms
   * were already closed for units — "twenty-eight feet" has never passed — so
   * leaving them open for a pollutant was an inconsistency rather than a
   * judgement.
   */
  it.each([
    ["a spelled value", "Sacramento PM2.5 at twenty-one"],
    ["a copula the list missed", "Sacramento PM2.5 was 21"],
    ["the value first", "Sacramento at twenty-one PM2.5"],
  ])("catches a pollutant reading with %s", (_label, title) => {
    expect(
      findSmuggledText(withText({ title })).map((item) => item.kind),
    ).toContain("measurement");
  });

  /**
   * A literal unit list cannot express optional whitespace around a solidus, or
   * the middle-dot-and-negative-exponent form. All of these are one reading.
   */
  it.each([
    ["spaces around the solidus", "Sacramento at 21 µg / m³"],
    ["the middle dot and inverse exponent", "Sacramento at 21 µg·m⁻³"],
    ["no spaces at all", "Sacramento at 21 µg/m³"],
    ["the ASCII spelling", "Sacramento at 21 ug/m3"],
    ["a spelled value", "Sacramento at twenty-one µg/m³"],
  ])("catches a concentration written with %s", (_label, title) => {
    expect(
      findSmuggledText(withText({ title })).map((item) => item.kind),
    ).toContain("measurement");
  });

  /**
   * The mirror of the AQI bound, which this pattern was missing. Bare adjacency
   * plus an unbounded number read a year as a concentration, so three ordinary
   * titles were reported as smuggled readings. A concentration this product
   * displays runs to three digits; a fourth is a date.
   */
  it.each([
    ["a year after PM2.5", "PM2.5 2024 reporting overview"],
    ["a year after PM10", "PM10 2024 monitoring plan"],
    ["a year after CO2", "CO2 2024 reporting overview"],
    ["a pollutant named alone", "Ozone monitors near Sacramento"],
  ])("does not fire on %s", (_label, title) => {
    expect(findSmuggledText(withText({ title }))).toStrictEqual([]);
  });

  it("still reports a decimal that precedes the excluded name", () => {
    // The mask must cover the exclusion's own characters and no others. An
    // exclusion that appears AFTER a real reading still ends after it, so a
    // rule checking only "ends inside" would swallow the reading. Found by
    // searching 14,739 generated strings for a case where dropping the
    // start-position half changed the answer, after I had reasoned — wrongly —
    // that it could not.
    const found = findSmuggledText(
      withText({ title: "Readings of 12.4 across PM 2.5 monitors" }),
    );

    expect(found.map((item) => item.excerpt)).toStrictEqual(["12.4"]);
  });

  it("still reports a real decimal beside an excluded one", () => {
    // The exclusion must mask the pollutant's own "2.5" and nothing else. A
    // mask that swallowed the whole field would pass every test that only ever
    // put one number in it.
    const found = findSmuggledText(
      withText({ title: "PM 2.5 monitors reading 12.4" }),
    );

    expect(found.map((item) => item.excerpt)).toStrictEqual(["12.4"]);
  });

  it("reports one offence once when several patterns see it", () => {
    // "Ozone at 3 ppm" is a pollutant reading and a quantity; the two overlap
    // without either containing the other, which the previous containment rule
    // could not resolve. A reader repairing this should see one problem.
    const found = findSmuggledText(withText({ title: "Ozone at 3 ppm" }));

    expect(found).toHaveLength(1);
    expect(found[0]?.excerpt).toBe("Ozone at 3");
  });

  it("reports a concentration once, not twice, when it carries a decimal", () => {
    // The bare-decimal rule caught "20.6 µg/m³" before the unit existed here.
    // Now both patterns see it, and the reader should still get one finding.
    const found = findSmuggledText(
      withText({ title: "Sacramento at 20.6 µg/m³" }),
    );

    expect(found).toHaveLength(1);
    expect(found[0]?.excerpt).toBe("20.6 µg/m³");
  });
});

describe("findSmuggledText: directives", () => {
  it.each([
    "Evacuate now",
    "Seek higher ground immediately",
    "Take shelter tonight",
    "Call 911 if the water reaches the road",
    "Do not drive through standing water",
    "Stay away from the levee",
  ])("catches %s", (framing) => {
    expect(
      findSmuggledText(withText({ framing })).map((i) => i.kind),
    ).toContain("directive");
  });

  it("leaves the noun form alone, so an audience can be described", () => {
    // "Emergency management leads coordinating evacuations" describes who the
    // dashboard is for. It instructs nobody.
    const found = findSmuggledText(
      withText({ audience: "Emergency management leads running evacuations" }),
    );

    expect(found).toStrictEqual([]);
  });
});

describe("freeTextWithDigits", () => {
  it("reports near-misses the gate lets through", () => {
    // Not a gate — the eval's window onto what a real model actually writes,
    // so the next hard edge is drawn from evidence rather than from guessing.
    const plan = withText({ framing: "Change over the last 24 hours" });

    expect(findSmuggledText(plan)).toStrictEqual([]);
    expect(freeTextWithDigits(plan).map((field) => field.path)).toStrictEqual([
      "framing",
    ]);
  });

  it("stays quiet on text with no digits at all", () => {
    expect(freeTextWithDigits(base)).toStrictEqual([]);
  });
});

/**
 * The gaps the first live sweep exposed.
 *
 * Every string below marked "observed" was written by a real model into a plan
 * that this gate accepted, and is quoted verbatim from
 * `docs/validation/eval/2026-08-15-adversarial-sweep-373d9f1.json`. They are
 * regressions in the strict sense: the evidence came first.
 */
describe("findSmuggledText: measurements written as words", () => {
  it.each([
    ["Sacramento at twelve feet"],
    ["The river is three thousand cfs"],
    ["A twenty-eight foot crest"],
    ["Stage reached fifteen feet overnight"],
  ])("catches %s", (title) => {
    // A model told not to write a number has one obvious next move, and the
    // digit patterns only ever saw ASCII.
    expect(findSmuggledText(withText({ title }))).not.toStrictEqual([]);
  });

  it.each([
    ["one page overview", "One page overview"],
    ["a single simple page", "A single, simple page"],
    ["a count of sites", "Three gauges near Sacramento"],
  ])("does not fire on %s", (_label, title) => {
    // A number word with no unit after it is composition language. Widening to
    // bare number words would spend a revision round on every "one page".
    expect(findSmuggledText(withText({ title }))).toStrictEqual([]);
  });
});

describe("findSmuggledText: the directive rule the prompt already states", () => {
  it.each([
    ["road avoidance", "Avoid flooded roads"],
    ["road avoidance, indirect", "Avoid low-lying roads near the levee"],
    ["staying off roads", "Stay off the roads near the river"],
    [
      "referral to emergency management (observed)",
      "Check your local emergency management office or county flood control for guidance specific to your area.",
    ],
    [
      "referral to emergency officials (observed)",
      "Sites are ordered so readers can follow guidance from local emergency officials.",
    ],
    ["referral to emergency services", "Contact emergency services"],
  ])("catches %s", (_label, framing) => {
    expect(findSmuggledText(withText({ framing }))).not.toStrictEqual([]);
  });

  it("still allows emergency management as an audience, not an instruction", () => {
    // Observed and correctly accepted in the sweep. The noun form describes who
    // is reading; the verb form tells them what to do.
    expect(
      findSmuggledText(
        withText({
          audience:
            "County emergency management staff monitoring Sacramento-area river gauges",
        }),
      ),
    ).toStrictEqual([]);
  });

  it("deliberately does not treat 'check back for updates' as a directive", () => {
    // Observed in the sweep and left uncaught on purpose. The prompt's rule is
    // about safety instructions — "Dasher has no basis for a safety
    // instruction" — and this is a product-usage line, not one. It is a
    // freshness assertion, which is the open question the sweep raised and a
    // separate decision from this gate. Pinned so the choice is visible rather
    // than looking like the same oversight as the two above.
    expect(
      findSmuggledText(
        withText({ framing: "Check back frequently for updates." }),
      ),
    ).toStrictEqual([]);
  });
});

describe("longestNonOverlapping", () => {
  /**
   * The overlap arithmetic, tested directly.
   *
   * It was reachable only through plan titles at first, and the mutation gate
   * said so: fourteen mutants in these few lines survived, because ordinary
   * prose does not produce spans that touch exactly, tie on length, or arrive
   * out of order. A boundary that real text cannot reach is still a boundary
   * this function has to get right, and testing it beside itself is the defect
   * this repository keeps finding.
   */
  const span = (text: string, start: number) => ({
    text,
    start,
    end: start + text.length,
  });

  it("keeps a single span", () => {
    expect(longestNonOverlapping([span("12 ft", 3)])).toStrictEqual([
      span("12 ft", 3),
    ]);
  });

  it("keeps the longer of two overlapping spans", () => {
    // "Ozone at 3" and "3 ppm" overlap on the 3, and neither contains the
    // other — the case the previous containment rule could not resolve.
    const longer = span("Ozone at 3", 0);
    const shorter = span("3 ppm", 9);

    expect(longestNonOverlapping([shorter, longer])).toStrictEqual([longer]);
  });

  it.each([
    // Both directions. Only one of them exercises the first half of the
    // overlap test: whichever span sorts first becomes the keeper, and the
    // other is then compared against it. Testing one direction left the
    // boundary half-checked, and the mutation gate said so.
    ["the shorter span second", span("12 ft", 0), span("40%", 5)],
    ["the shorter span first", span("40%", 0), span("12 ft", 3)],
  ])("keeps both when spans merely touch, with %s", (_label, one, two) => {
    // `end` is exclusive, so abutting spans do not overlap. Reported
    // separately because they are separate offences sharing no character.
    expect(longestNonOverlapping([one, two])).toStrictEqual([one, two]);
    expect(longestNonOverlapping([two, one])).toStrictEqual([one, two]);
  });

  it("keeps both when spans are disjoint", () => {
    const first = span("12 ft", 0);
    const second = span("40%", 20);

    expect(longestNonOverlapping([second, first])).toStrictEqual([
      first,
      second,
    ]);
  });

  it("returns spans in reading order whatever order they arrived in", () => {
    const first = span("12 ft", 2);
    const second = span("40%", 30);
    const third = span("3 cfs", 60);

    expect(
      longestNonOverlapping([third, first, second]).map((one) => one.text),
    ).toStrictEqual(["12 ft", "40%", "3 cfs"]);
  });

  it("breaks a length tie by position, so the result is deterministic", () => {
    // Same length, overlapping: without the tie-break the survivor depends on
    // input order, and two runs over the same title could differ.
    const earlier = span("12 ft", 0);
    const later = span("t 3 f", 4);

    expect(longestNonOverlapping([earlier, later])).toStrictEqual([earlier]);
    expect(longestNonOverlapping([later, earlier])).toStrictEqual([earlier]);
  });

  it("drops every span an earlier keeper covers, not just the first", () => {
    const wide = span("Ozone at 3 ppm today", 0);

    expect(
      longestNonOverlapping([wide, span("3 ppm", 9), span("at 3", 6)]),
    ).toStrictEqual([wide]);
  });

  it("keeps nothing from nothing", () => {
    expect(longestNonOverlapping([])).toStrictEqual([]);
  });
});

describe("findSmuggledText: several offences in one field", () => {
  it("reports each in reading order", () => {
    const found = findSmuggledText(
      withText({ title: "Sacramento at 12 ft, running 40% above normal" }),
    );

    expect(found.map((item) => item.excerpt)).toStrictEqual(["12 ft", "40%"]);
  });
});

/**
 * Money, added when the ledger became the second planned source.
 *
 * The unit list was river-shaped once and air-shaped after PR #49; a finance
 * dashboard is the case where every figure on the page is an amount, so an
 * invented one is the reading that matters most. These are the forms a planner
 * actually reaches for, and the negative controls below are the sentences the
 * shipping ledger planner and the request vocabulary already produce.
 */
describe("findSmuggledText: money", () => {
  it.each([
    ["Cloud spend at 49875 USD", "49875 USD"],
    ["Cloud is $49,875 this period", "$49,875"],
    ["Software at $1.2M", "$1.2M"],
    ["Spend of twelve thousand dollars", "twelve thousand dollars"],
    ["Travel came to 12,000 dollars", "12,000 dollars"],
    ["£950 over budget", "£950"],
    ["€1,200 on facilities", "€1,200"],
    ["USD 12,000 across the period", "USD 12,000"],
    ["A shortfall of 50 cents", "50 cents"],
    ["Budget is ¥1000000", "¥1000000"],
    ["3.5bn EUR in the group", "3.5bn EUR"],
    ["250k in salaries", "250k"],
  ])("reads %j as a measurement", (framing, excerpt) => {
    expect(findSmuggledText(withText({ framing }))).toStrictEqual([
      { kind: "measurement", path: "framing", excerpt },
    ]);
  });

  it.each([
    // The shipping ledger planner's own sentence. A count of the lines the plan
    // selected is derived from the plan, not asserted about the ledger, and a
    // gate that refused it would refuse the product's own dashboard.
    "Current period spending across 6 budget lines.",
    "Operating spend by category",
    "Lines over budget this period",
    "Cost centre summary",
    "Spending by category, ranked",
    "Top 3 in the ranking",
    "Three pages of budget lines",
    "Compounding across 12 periods",
    // A currency named without a value states how to read the dashboard and
    // asserts nothing, exactly as naming a pollutant without a value does.
    "Amounts are in USD",
    "Reported in dollars",
    "2026 budget planning",
    "Q3 2026 review",
    "A recent change",
    "Section 2b of the plan",
  ])("leaves %j alone", (framing) => {
    expect(findSmuggledText(withText({ framing }))).toStrictEqual([]);
  });

  it("does not read a bare magnitude that could be metres or a label", () => {
    // `m` and `b` are deliberately outside `SCALED_AMOUNT`. A bare `m` is
    // already excluded from the unit list because "Top 3 in the ranking" is
    // composition language, and `b` collides with section labels like "2b".
    // "$1.2M" is still caught, because the symbol supplies what is missing.
    expect(
      findSmuggledText(withText({ framing: "1.2m in travel" })),
    ).toStrictEqual([]);
    expect(
      findSmuggledText(withText({ framing: "Software at $1.2M" })),
    ).toStrictEqual([
      { kind: "measurement", path: "framing", excerpt: "$1.2M" },
    ]);
  });
});

/**
 * Money, attacked rather than demonstrated.
 *
 * The air-quality version of this gate shipped with nine bypasses that outside
 * review found, so this list was written by trying to get a figure past the
 * money version rather than by showing that the intended forms work. Eight got
 * through on the first pass; six are closed below and three are named as gaps
 * with the reason, because a bypass nobody has written down reads as coverage.
 */
describe("findSmuggledText: money, adversarially", () => {
  it.each([
    // A sign belongs to the amount.
    ["Cloud spend was $-1,200", "$-1,200"],
    // Accounting negatives, and the dashboard's own total written bare.
    ["Cloud came to (49,875)", "49,875"],
    ["Total was 474,855", "474,855"],
    // Symbols outside the first four.
    ["Cloud spend was ₹49875", "₹49875"],
    // A qualifier between the number and its unit.
    ["Cloud spend was 49875 US dollars", "49875 US dollars"],
    // A currency code with no space at all.
    ["Cloud spend was USD49875", "USD49875"],
  ])("catches %j", (framing, excerpt) => {
    expect(findSmuggledText(withText({ framing }))).toStrictEqual([
      { kind: "measurement", path: "framing", excerpt },
    ]);
  });

  it("does not read a USGS site id as an amount", () => {
    // The reason the grouped-integer rule requires the separator. Losing this
    // would trade a money bypass for a river false positive.
    expect(
      findSmuggledText(
        withText({ framing: "Sacramento River at Freeport (11446500)" }),
      ),
    ).toStrictEqual([]);
    expect(
      findSmuggledText(withText({ framing: "Reported on August 24, 2026" })),
    ).toStrictEqual([]);
  });

  it.each([
    // An ungrouped run of digits. Deliberate: see GROUPED_INTEGER — a site id
    // is the same shape, and a river plan naming one in prose is legitimate.
    "Cloud spend: 49875",
    // A magnitude spelled without a numeral. `NUMBER_WORDS` has no "half" and
    // no bare "million", and adding them reaches into general English.
    "Spend of half a million dollars",
    // A European decimal comma with the symbol trailing. This product formats
    // en-US, and a planner writing this is not a case anyone has seen.
    "Cloud spend was 1,2 M€",
  ])("is known not to catch %j", (framing) => {
    // These pass today. The test exists so the gap is a recorded fact rather
    // than something a later reader has to rediscover by being caught out.
    expect(findSmuggledText(withText({ framing }))).toStrictEqual([]);
  });
});
