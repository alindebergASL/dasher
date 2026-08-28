import { canonicalSpecBytes } from "@dasher/dashboard-schema";
import { describe, expect, it } from "vitest";

import { operatingSpendFixture } from "@dasher/ledger-domain/fixture";
import type { LedgerSnapshot } from "@dasher/ledger-domain";

import { compileLedgerPlan, LedgerPlanRejected } from "./compile-ledger";
import { LedgerPlanSchema, type LedgerPlan } from "./ledger-plan";
import {
  DETERMINISTIC_LEDGER_PLANNER,
  planLedgerDashboard,
} from "./ledger-provider";

const snapshot = operatingSpendFixture();
const lineIds = snapshot.lines.map((line) => line.id);
const AS_OF = "2026-08-24T12:00:00.000Z";
const options = { asOf: AS_OF, planner: DETERMINISTIC_LEDGER_PLANNER };

function compile(plan: LedgerPlan = planLedgerDashboard("spending", lineIds)) {
  return compileLedgerPlan(plan, snapshot, options);
}

describe("compileLedgerPlan", () => {
  it("produces a dashboard the contract accepts", () => {
    const spec = compile();

    expect(spec.schemaVersion).toBe("1.2");
    expect(spec.pages.length).toBeGreaterThan(0);
    expect(spec.evidence.length).toBeGreaterThan(snapshot.lines.length);
  });

  /**
   * The property this whole slice exists to establish, asserted on the
   * serialized spec rather than by reading the source. Before this compiler
   * there was no dashboard for which it could be true: `compilePlan` takes
   * `readonly Station[]`, so every planned dashboard carried site ids and
   * coordinates by construction.
   */
  it("carries no station, gauge, river, coordinate, or site vocabulary", () => {
    const serialized = JSON.stringify(compile());

    expect(serialized).not.toMatch(
      /siteId|latitude|longitude|gauge|river|station/iu,
    );
  });

  it("builds only the component kinds that are genuinely domain-neutral", () => {
    // Five of the contract's seven. The two absent ones — station-map and
    // station-table — are the two that were never neutral, and not building
    // them is what "the renderer is general" has to mean.
    const kinds = new Set(
      compile().pages.flatMap((page) =>
        page.components.map((component) => component.kind),
      ),
    );

    expect([...kinds].sort()).toStrictEqual([
      "alert-list",
      "metric-grid",
      "ranking",
      "summary",
    ]);
    expect(kinds.has("station-map")).toBe(false);
    expect(kinds.has("station-table")).toBe(false);
  });

  it("gives every rendered figure an evidence record that exists", () => {
    const spec = compile();
    const known = new Set(spec.evidence.map((item) => item.id));
    const referenced = new Set<string>();

    const collect = (ids: readonly string[] | undefined) =>
      ids?.forEach((id) => referenced.add(id));
    for (const page of spec.pages) {
      for (const component of page.components) {
        collect(component.evidenceIds);
        if (component.kind === "summary")
          component.claims.forEach((claim) => collect(claim.evidenceIds));
        if (component.kind === "metric-grid")
          component.metrics.forEach((metric) => collect(metric.evidenceIds));
        if (component.kind === "ranking")
          component.items.forEach((item) => collect(item.evidenceIds));
        if (component.kind === "alert-list")
          component.alerts.forEach((alert) => collect(alert.evidenceIds));
        if (component.kind === "trend-list")
          component.series.forEach((series) => collect(series.evidenceIds));
      }
    }

    expect(referenced.size).toBeGreaterThan(0);
    expect([...referenced].filter((id) => !known.has(id))).toStrictEqual([]);
  });

  it("names the planner in the evidence and the architecture", () => {
    const spec = compile();

    expect(
      spec.evidence.find((item) => item.id === "planner-composition")
        ?.sourceName,
    ).toBe("Dasher planner (fake-ledger-planner-v1)");
    // Not "ai": no model ran, and the panel that explains how the dashboard was
    // made is the one place that claim would mislead.
    expect(
      spec.architecture.nodes.find((node) => node.id === "ledger-planner")
        ?.kind,
    ).toBe("process");
  });

  it("takes trend values from the snapshot, period by period", () => {
    const plan = planLedgerDashboard("monthly trends", lineIds);
    const spec = compileLedgerPlan(plan, snapshot, options);
    const trend = spec.pages
      .flatMap((page) => page.components)
      .find((component) => component.kind === "trend-list");

    expect(trend).toBeDefined();
    const cloud = trend?.kind === "trend-list" ? trend.series[0] : undefined;
    // Numbers, not the exact decimal text the snapshot carries. A trend point
    // is a plot coordinate the renderer scales rather than a figure anyone
    // reads, and the contract types it as a number — the one place a ledger
    // amount deliberately becomes a double. Every STATED figure stays exact.
    expect(cloud?.points.map((point) => point.value)).toStrictEqual(
      snapshot.lines[0]!.amounts.map(Number),
    );
    expect(cloud?.points[0]?.at).toBe("2026-03-01T00:00:00.000Z");
  });

  it("omits the over-budget section when nothing is over, rather than showing an empty one", () => {
    const under = {
      ...snapshot,
      lines: snapshot.lines.map((line) => ({
        ...line,
        // Above every amount, so no line is over budget. Compared as numbers
        // only to pick the bound; the value handed back is decimal text.
        budgetPerPeriod: String(Math.max(...line.amounts.map(Number)) + 1),
      })),
    };
    const plan = planLedgerDashboard("budget review", lineIds);

    const kinds = compileLedgerPlan(plan, under, options).pages.flatMap(
      (page) => page.components.map((component) => component.kind),
    );

    expect(kinds).not.toContain("alert-list");
    // The page survives, because its other sections still built something.
    expect(kinds.length).toBeGreaterThan(0);
  });

  it("refuses a plan whose lines are not in the ledger", () => {
    const plan = LedgerPlanSchema.parse({
      ...planLedgerDashboard("spending", lineIds),
      lineIds: ["not-a-line"],
    });

    expect(() => compileLedgerPlan(plan, snapshot, options)).toThrow(
      LedgerPlanRejected,
    );
  });

  it("compiles the same bytes from the same input", () => {
    // A dashboard that differed between two identical runs could not be
    // reviewed, cached, or compared against a saved one.
    expect(canonicalSpecBytes(compile())).toStrictEqual(
      canonicalSpecBytes(compile()),
    );
  });

  it("changes the dashboard when the request changes", () => {
    const budget = compileLedgerPlan(
      planLedgerDashboard("budget variance review", lineIds),
      snapshot,
      options,
    );
    const trends = compileLedgerPlan(
      planLedgerDashboard("monthly trends over time", lineIds),
      snapshot,
      options,
    );

    expect(budget.title).not.toBe(trends.title);
    expect(canonicalSpecBytes(budget)).not.toStrictEqual(
      canonicalSpecBytes(trends),
    );
  });
});

/**
 * The figures a reader actually reads.
 *
 * The first version of this suite checked structure — which components exist,
 * that evidence resolves — and the mutation gate scored the compiler at 52.83%,
 * the worst file in the repository. Almost every survivor was a formatted
 * value or a sentence: the shape was pinned and the content was not. For a
 * compiler whose whole claim is that it computes every number, that is the
 * wrong half to have tested.
 *
 * Expected values are written as arithmetic against the fixture rather than as
 * copied literals, so a fixture edit moves the test with it instead of leaving
 * a stale number that still passes.
 */
describe("the figures a ledger dashboard displays", () => {
  const spec = compile(planLedgerDashboard("budget review", lineIds));
  const components = spec.pages.flatMap((page) => page.components);
  const find = <TKind extends string>(kind: TKind) =>
    components.find((component) => component.kind === kind);

  /**
   * Read as numbers on purpose, and only here.
   *
   * These tests assert the STRING a reader sees — a currency to whole units, a
   * percentage to one decimal place. The exactness of the underlying figures is
   * asserted in `@dasher/ledger-domain`, against the engine, with no tolerance.
   * A float oracle at this precision could only disagree if a value sat on a
   * rounding boundary, and none of this fixture's do: the shares are
   * 65.15673206, 10.50…, 8.33… and the changes 7.69812136 and -10.40723982.
   */
  const latest = (id: string) =>
    Number(snapshot.lines.find((line) => line.id === id)!.amounts.at(-1));
  const prior = (id: string) =>
    Number(snapshot.lines.find((line) => line.id === id)!.amounts.at(-2));
  const total = snapshot.lines.reduce(
    (sum, line) => sum + Number(line.amounts.at(-1)),
    0,
  );
  const priorTotal = snapshot.lines.reduce(
    (sum, line) => sum + Number(line.amounts.at(-2)),
    0,
  );

  it("formats money in whole units of the ledger's currency", () => {
    const grid = find("metric-grid");
    const metrics = grid?.kind === "metric-grid" ? grid.metrics : [];

    expect(metrics[0]?.value).toBe(
      new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: snapshot.currency,
        maximumFractionDigits: 0,
      }).format(total),
    );
    // Cents on an operating total are noise, and the contract's short text is
    // for a reader rather than for a ledger reconciliation.
    expect(metrics[0]?.value).not.toMatch(/\.\d/u);
  });

  it("states the period-over-period change with its sign and direction", () => {
    const grid = find("metric-grid");
    const metrics = grid?.kind === "metric-grid" ? grid.metrics : [];
    const change = ((total - priorTotal) / priorTotal) * 100;

    expect(metrics[0]?.change).toBe(`+${change.toFixed(1)}%`);
    expect(metrics[0]?.direction).toBe("up");
  });

  it("counts the lines and the lines over budget", () => {
    const grid = find("metric-grid");
    const metrics = grid?.kind === "metric-grid" ? grid.metrics : [];

    expect(metrics[1]?.value).toBe(String(snapshot.lines.length));
    expect(metrics[2]?.value).toBe("2");
  });

  it("reports the largest share to one decimal place", () => {
    const grid = find("metric-grid");
    const metrics = grid?.kind === "metric-grid" ? grid.metrics : [];
    const biggest = Math.max(
      ...snapshot.lines.map((line) => Number(line.amounts.at(-1))),
    );

    expect(metrics[3]?.value).toBe(`${((biggest / total) * 100).toFixed(1)}%`);
  });

  it("writes a summary that names the total, the mover, and the count over budget", () => {
    const summary = find("summary");
    const claims = summary?.kind === "summary" ? summary.claims : [];

    expect(claims[0]?.text).toContain(`Total spending for 2026-08 was`);
    expect(claims[0]?.text).toContain("against 2026-07");
    expect(claims[1]?.text).toContain("Contractors moved most, down");
    expect(claims[2]?.text).toBe("2 lines are over budget for the month.");
    expect(summary?.kind === "summary" ? summary.tone : undefined).toBe(
      "attention",
    );
  });

  it("shows each mover's change with an explicit sign and its share", () => {
    const ranking = find("ranking");
    const items = ranking?.kind === "ranking" ? ranking.items : [];
    const contractors = items.find((item) => item.id === "contractors");
    const fall = latest("contractors") - prior("contractors");

    // A minus sign, not a hyphen: this is a figure, not a range.
    expect(contractors?.value).toBe(
      `−$${Math.abs(fall).toLocaleString("en-US")}`,
    );
    expect(contractors?.note).toContain(
      `${((fall / prior("contractors")) * 100).toFixed(1)}%`,
    );
    expect(contractors?.note).toContain("of total");
    // Biggest absolute move first, regardless of direction.
    expect(items[0]?.id).toBe("contractors");
  });

  it("says how far over budget each flagged line is", () => {
    const alerts = find("alert-list");
    const list = alerts?.kind === "alert-list" ? alerts.alerts : [];
    const cloud = list.find((alert) => alert.id === "over-cloud");
    const budget = snapshot.lines.find(
      (line) => line.id === "cloud",
    )!.budgetPerPeriod!;

    expect(cloud?.title).toBe("Cloud infrastructure");
    expect(cloud?.detail).toContain(
      `over by $${(latest("cloud") - Number(budget)).toLocaleString("en-US")}`,
    );
    expect(cloud?.severity).toBe("attention");
  });

  it("names the period in the freshness label and claims no observation instant", () => {
    expect(spec.freshness.label).toBe(
      "Ledger as of 2026-08; one month behind close",
    );
    expect(spec.freshness.status).toBe("partial");
    // A ledger has no instant of observation. Supplying one rendered as
    // "Latest observation 12:00 AM UTC", which is a fact about the formatter.
    expect(spec.freshness.latestObservationAt).toBeUndefined();
  });

  it("writes an executive brief from the same figures", () => {
    expect(spec.executiveBrief.known.headline).toContain("across 6 lines");
    expect(spec.executiveBrief.changed.headline).toContain("against 2026-07");
    expect(spec.executiveBrief.important.headline).toBe("2 lines over budget");
    expect(spec.executiveBrief.important.detail).toContain(
      "Cloud infrastructure, Software licences",
    );
  });

  it("says a change was not computed rather than naming a false reason", () => {
    const single = {
      ...snapshot,
      periods: ["2026-07", "2026-08"],
      lines: [{ id: "only", label: "Only line", amounts: ["0", "500"] }],
    };
    const grid = compileLedgerPlan(
      planLedgerDashboard("spending", ["only"]),
      single,
      options,
    )
      .pages.flatMap((page) => page.components)
      .find((component) => component.kind === "metric-grid");

    /*
     * This asserted "no prior period", and the string was false every time it
     * rendered. A latest period always HAS a prior one — the schema requires two
     * — so a null change percent means the column was refused, never that the
     * period was missing. Here the line is 0 then 500: the prior period exists
     * and its amount is zero, which is precisely the case the old wording
     * denied.
     */
    expect(grid?.kind === "metric-grid" ? grid.metrics[0]?.change : "").toBe(
      "change not computed",
    );
  });

  it("says which line is largest when nothing is over budget", () => {
    const under = {
      ...snapshot,
      lines: snapshot.lines.map((line) => ({
        ...line,
        // Above every amount, so no line is over budget. Compared as numbers
        // only to pick the bound; the value handed back is decimal text.
        budgetPerPeriod: String(Math.max(...line.amounts.map(Number)) + 1),
      })),
    };
    const brief = compileLedgerPlan(
      planLedgerDashboard("spending", lineIds),
      under,
      options,
    ).executiveBrief;

    expect(brief.important.headline).toBe(
      "Salaries and benefits is the largest share",
    );
    expect(brief.important.detail).toContain("% of spending in 2026-08");
  });
});

/**
 * What a reader is shown when a ratio has no denominator.
 *
 * The compiler used to print a fabricated `0.0%` here, because
 * `deriveLedgerFacts` substituted a literal `"0"` for the null the engine
 * returned. These pin both halves of the repair: the shares that ARE computable
 * survive a sibling ratio failing, and the ones that genuinely are not say so
 * in words instead of in a number.
 */
describe("when a credit offsets spending", () => {
  /*
   * Shares only mean "part of a whole" when every part has the sign of the
   * whole. With a credit in the ledger they do not: +$200 against -$100 nets to
   * $100, so the shares are +200% and -100%. Both figures are exact and they sum
   * to 100 — what was wrong was the sentence built on them, which read "Alpha
   * accounts for 200.0% of spending in 2026-08".
   */
  const offsetting = {
    ...snapshot,
    periods: ["2026-07", "2026-08"],
    lines: [
      { id: "alpha", label: "Alpha", amounts: ["200", "200"] },
      { id: "credit", label: "Vendor credit", amounts: ["-100", "-100"] },
    ],
  };
  const brief = compileLedgerPlan(
    planLedgerDashboard("spending", ["alpha", "credit"]),
    offsetting,
    options,
  ).executiveBrief;

  it("does not name a largest share of a net total", () => {
    expect(brief.important.headline).toBe("Credits offset spending in 2026-08");
    expect(brief.important.detail).toContain("net figure");
    expect(brief.important.detail).not.toContain("accounts for");
    expect(brief.important.detail).not.toContain("200.0%");
  });

  it("still reports the shares themselves, which are exact", () => {
    // The percentages are not suppressed. They were computed and they are
    // right; only the claim that one of them is a majority of spending goes.
    const notes = compileLedgerPlan(
      planLedgerDashboard("spending", ["alpha", "credit"]),
      offsetting,
      options,
    )
      .pages.flatMap((page) => page.components)
      .flatMap((component) =>
        component.kind === "ranking"
          ? component.items.map((item) => item.note ?? "")
          : [],
      );

    expect(notes.join(" ")).toContain("200.0% of total");
    expect(notes.join(" ")).toContain("-100.0% of total");
  });
});

describe("when a share has no denominator", () => {
  const periods = ["2026-06", "2026-07", "2026-08"];
  const base = { ...snapshot, periods };
  const plan = planLedgerDashboard("spending", ["alpha", "beta"]);
  const componentsOf = (lines: LedgerSnapshot["lines"]) =>
    compileLedgerPlan(plan, { ...base, lines }, options).pages.flatMap(
      (page) => page.components,
    );

  describe("and it is a sibling ratio that failed", () => {
    // Beta was zero last period, so `changePercent` cannot divide. Every period
    // total is non-zero, so every share can.
    const components = componentsOf([
      { id: "alpha", label: "Alpha", amounts: ["100", "100", "60"] },
      { id: "beta", label: "Beta", amounts: ["100", "0", "40"] },
    ]);

    it("prints the shares that were computed, not zeroes", () => {
      const ranking = components.find(
        (component) => component.kind === "ranking",
      );
      const notes =
        ranking?.kind === "ranking" ? ranking.items.map((one) => one.note) : [];

      // Asserted as whole notes rather than by substring: "60.0% of total"
      // contains "0.0% of total", so a `not.toContain` here would pass on the
      // fabricated zero it was written to catch.
      expect(notes).toStrictEqual([
        "change not computed · 60.0% of total",
        "change not computed · 40.0% of total",
      ]);
    });

    it("still reports the largest of them", () => {
      const grid = components.find(
        (component) => component.kind === "metric-grid",
      );
      const largest =
        grid?.kind === "metric-grid"
          ? grid.metrics.find((one) => one.label === "Largest share")?.value
          : undefined;

      expect(largest).toBe("60.0%");
    });
  });

  describe("and the share column was refused for the whole ledger", () => {
    /*
     * This block was named "and there was genuinely no total to divide by",
     * which was false about its own fixture: 2026-06 sums to zero, and 2026-08
     * — the period every one of these assertions is about — totals $100.
     *
     * `share` is refused for the snapshot because the window is partitioned by
     * period and the rows cannot be filtered without changing the totals of the
     * periods that remain. That is the accepted limitation. What was NOT
     * acceptable was telling a reader looking at a $100 total that there was no
     * total to divide by.
     */
    const lines = [
      { id: "alpha", label: "Alpha", amounts: ["0", "100", "60"] },
      { id: "beta", label: "Beta", amounts: ["0", "100", "40"] },
    ];
    const components = componentsOf(lines);
    const brief = compileLedgerPlan(
      plan,
      { ...base, lines },
      options,
    ).executiveBrief;

    it("says so in words rather than printing a percentage", () => {
      const ranking = components.find(
        (component) => component.kind === "ranking",
      );
      const notes =
        ranking?.kind === "ranking" ? ranking.items.map((one) => one.note) : [];

      // The whole notes, not a predicate over them: `every` on an empty array
      // is vacuously true, so a missing ranking component would have passed
      // this test rather than failed it.
      // Neither half names a cause any more. The row does not know one: the
      // columns were refused for the ledger, not for this line.
      expect(notes).toStrictEqual([
        "change not computed · share not computed",
        "change not computed · share not computed",
      ]);
    });

    it("leaves the largest-share stat empty rather than claiming a winner", () => {
      const grid = components.find(
        (component) => component.kind === "metric-grid",
      );
      const largest =
        grid?.kind === "metric-grid"
          ? grid.metrics.find((one) => one.label === "Largest share")?.value
          : undefined;

      expect(largest).toBe("—");
    });

    it("reports the total in the brief instead of naming a largest share", () => {
      // The old code sorted for a `biggest` unconditionally and read a
      // fabricated `0` off it, so this slot announced that some arbitrary line
      // "accounts for 0.0% of spending".
      expect(brief.important.headline).toBe(
        "No line's share of 2026-08 was computed",
      );
      expect(brief.important.detail).toContain("totalled $100");
      expect(brief.important.detail).not.toContain("0.0%");
    });

    it("still explains the missing share when a line is over budget", () => {
      /*
       * The over-budget headline wins, as it should — it is the thing to act on.
       * But the first version made the explanation an ALTERNATIVE to it, so this
       * combination put an em dash in the metric grid and said nothing anywhere
       * on the page about why. It is the case where a reader is most likely to
       * be reading the grid.
       */
      const overBudget = compileLedgerPlan(
        plan,
        {
          ...base,
          lines: lines.map((line) => ({ ...line, budgetPerPeriod: "10" })),
        },
        options,
      ).executiveBrief;

      expect(overBudget.important.headline).toBe("2 lines over budget");
      expect(overBudget.important.detail).toContain("exceeded the budget");
      expect(overBudget.important.detail).toContain(
        "No line's share of 2026-08 was computed",
      );
    });

    it("does not deny the total in the same breath as stating it", () => {
      /*
       * The assertion this replaces required the detail to contain BOTH
       * "totalled $100" and "nothing to divide by" — a self-contradiction,
       * pinned on adjacent lines of a test written to remove exactly this class
       * of defect. Every string a reader sees about the missing share is checked
       * here against the total the same page reports.
       */
      const said = [
        brief.important.detail,
        brief.changed.headline,
        ...components.flatMap((component) =>
          component.kind === "ranking"
            ? component.items.map((item) => item.note ?? "")
            : component.kind === "summary"
              ? component.claims.map((claim) => claim.text)
              : [],
        ),
      ];

      expect(brief.important.detail).toContain("that total is exact");
      for (const sentence of said) {
        expect(sentence).not.toContain("no total to divide by");
        expect(sentence).not.toContain("nothing to divide by");
        expect(sentence).not.toContain("no prior period");
      }
    });
  });
});

/**
 * The remaining prose, and the sign rule underneath it.
 *
 * These are the strings a reader sees on the page and in the Architecture
 * panel. They are asserted for the same reason the station compiler's are: a
 * compiler that assembles sentences has those sentences as part of its output,
 * and a test that pins only the structure leaves most of what it produces
 * unchecked.
 */
describe("the prose a ledger dashboard carries", () => {
  const spec = compile(planLedgerDashboard("monthly trends", lineIds));

  it("signs a positive change and leaves a negative one to its own minus", () => {
    const positive = compile(planLedgerDashboard("spending", ["cloud"]));
    const falling = compile(planLedgerDashboard("spending", ["contractors"]));
    const changeOf = (built: typeof positive) => {
      const grid = built.pages
        .flatMap((page) => page.components)
        .find((component) => component.kind === "metric-grid");
      return grid?.kind === "metric-grid" ? grid.metrics[0]?.change : undefined;
    };

    expect(changeOf(positive)?.startsWith("+")).toBe(true);
    expect(changeOf(falling)?.startsWith("-")).toBe(true);
  });

  it("signs an exactly flat change as positive rather than bare", () => {
    // The boundary the sign rule turns on. Without a case at zero, `>= 0` and
    // `> 0` are indistinguishable and the rule is not really tested.
    const flat = {
      ...snapshot,
      lines: [{ id: "flat", label: "Flat line", amounts: ["500", "500"] }],
      periods: ["2026-07", "2026-08"],
    };
    const grid = compileLedgerPlan(
      planLedgerDashboard("spending", ["flat"]),
      flat,
      options,
    )
      .pages.flatMap((page) => page.components)
      .find((component) => component.kind === "metric-grid");

    expect(grid?.kind === "metric-grid" ? grid.metrics[0]?.change : "").toBe(
      "+0.0%",
    );
  });

  it("titles and subtitles each section in the ledger's own words", () => {
    const byKind = new Map(
      spec.pages
        .flatMap((page) => page.components)
        .map((component) => [component.kind, component]),
    );

    expect(byKind.get("summary")?.title).toBe("Spending summary");
    expect(byKind.get("summary")?.subtitle).toBe(
      "What was spent in 2026-08, and what moved.",
    );
    expect(byKind.get("metric-grid")?.title).toBe("At a glance");
    expect(byKind.get("ranking")?.title).toBe("Largest movers");
    expect(byKind.get("ranking")?.subtitle).toBe(
      "Lines ranked by size of change against 2026-07, either direction.",
    );
    expect(byKind.get("trend-list")?.title).toBe("Spending by month");
  });

  it("explains the path in the architecture panel, in the ledger's terms", () => {
    expect(spec.architecture.title).toBe("How this dashboard was built");
    expect(spec.architecture.summary).toContain("normalized ledger snapshot");
    expect(spec.architecture.nodes.map((node) => node.id)).toStrictEqual([
      "ledger-source",
      "ledger-facts",
      "ledger-planner",
      "ledger-dashboard",
    ]);
    expect(
      spec.architecture.nodes.find((node) => node.id === "ledger-source")
        ?.detail,
    ).toBe(
      "Amounts per budget line per month, with the budget each line was given.",
    );
    expect(spec.architecture.edges.map((edge) => edge.label)).toStrictEqual([
      "amounts",
      "figures",
      "layout",
    ]);
  });

  it("tells the reader what Dasher does not know", () => {
    expect(spec.nextAction.title).toBe("Review the ledger export");
    expect(spec.nextAction.detail).toContain(
      "does not know about commitments, accruals, or reclassifications",
    );
    expect(spec.notice).toContain("normalized ledger export");
    expect(spec.notice).toContain("accounting system of record");
  });

  it("says which lines were rejected, and why, when a plan names none", () => {
    const plan = LedgerPlanSchema.parse({
      ...planLedgerDashboard("spending", lineIds),
      lineIds: ["absent-line"],
    });

    expect(() => compileLedgerPlan(plan, snapshot, options)).toThrow(
      /No line in this plan exists in the ledger/u,
    );
    try {
      compileLedgerPlan(plan, snapshot, options);
    } catch (error) {
      expect((error as Error).name).toBe("LedgerPlanRejected");
    }
  });

  it("names the direction a mover went, in words", () => {
    const summary = compile(planLedgerDashboard("spending", ["cloud"]))
      .pages.flatMap((page) => page.components)
      .find((component) => component.kind === "summary");
    const claims = summary?.kind === "summary" ? summary.claims : [];

    expect(claims[1]?.text).toContain("moved most, up ");
  });
});
