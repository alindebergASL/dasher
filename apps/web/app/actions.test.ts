// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import riverFixture from "../../../fixtures/usgs/sacramento-instantaneous-values.json";

import {
  planDashboard,
  refineDashboard,
  uploadLedgerDashboard,
} from "./actions";
import { clearSourceCache } from "./source-runtime";
import {
  DEFAULT_REQUEST,
  REFINEMENT_MAX_LENGTH,
  REQUEST_MAX_LENGTH,
} from "./planning";
import { UPLOAD_MAX_BYTES } from "./upload";
// A static type-only namespace import, deliberately, so the module's type is
// named without the dynamic-import type form. The generated-code gate is a
// text sweep: it forbids that form anywhere in first-party source and does not
// treat type positions differently from value ones -- nor comments differently
// from code, which is why this note does not quote the form it is avoiding.
import type * as SourceRuntime from "./source-runtime";
import type * as DashboardSchema from "@dasher/dashboard-schema";

/**
 * One domain can be taken offline at the source seam while the other keeps its
 * real fixture. Simulating two upstream protocols in a fetch mock proved
 * nothing useful: an unparseable stand-in body took BOTH sources down, so a
 * test meant to show independent failure was showing simultaneous failure.
 * `undefined` means every domain loads normally, which is the default for every
 * other test in this file.
 */
let unavailableDomains: readonly ("river" | "air")[] = [];

/**
 * Composition refusal has no natural trigger from the fake planner: the two
 * real halves always fit. What is under test is the ACTION's handling of that
 * refusal — which error it recognises and what it then tells a reader — so the
 * refusal is injected at the seam and the real composer is used everywhere
 * else.
 */
let composeRefuses = false;
/** A fault that is NOT a refusal, so the two branches can be told apart. */
let composeFaults = false;

vi.mock("@dasher/dashboard-schema", async (importOriginal) => {
  const actual = await importOriginal<typeof DashboardSchema>();
  return {
    ...actual,
    composeDashboards: (
      ...args: Parameters<typeof actual.composeDashboards>
    ) => {
      if (composeRefuses) {
        throw new actual.DashboardCompositionError(
          "The combined dashboard does not satisfy the dashboard contract.",
        );
      }
      if (composeFaults) {
        throw new TypeError("undefined is not a function");
      }
      return actual.composeDashboards(...args);
    },
  };
});

vi.mock("./source-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof SourceRuntime>();
  return {
    ...actual,
    loadDomainSnapshot: async (domain: "river" | "air") => {
      if (unavailableDomains.includes(domain)) {
        throw new actual.SourceUnavailableError(domain);
      }
      return actual.loadDomainSnapshot(domain);
    },
  };
});

/**
 * The server-action boundary.
 *
 * A server action is a public endpoint: anything that can reach the page can
 * call it with anything. The refinement path is the first one here that accepts
 * a structured argument rather than a string — the previous plan, handed back
 * by the browser — so it is the first one where "the client sent it" could be
 * mistaken for "it is valid".
 */

async function firstPlan() {
  const result = await planDashboard(DEFAULT_REQUEST);
  if (!result.ok || !result.plan) throw new Error("expected a plan");
  return result.plan;
}

describe("planDashboard", () => {
  it("returns the plan alongside the dashboard, so a change can be applied", async () => {
    const result = await planDashboard(DEFAULT_REQUEST);

    expect(result.ok).toBe(true);
    expect(result.plan?.planVersion).toBe("plan-v1");
    expect(result.dashboard?.schemaVersion).toBe("1.2");
  });

  it("builds the official UCR enrollment snapshot without a sensor plan", async () => {
    const result = await planDashboard(
      "Current student enrollment at UC Riverside",
      {
        persist: false,
      },
    );

    expect(result.ok).toBe(true);
    expect(result.plan).toBeUndefined();
    expect(result.dashboard?.title).toBe("UC Riverside Enrollment — Fall 2025");
    expect(JSON.stringify(result.dashboard)).not.toMatch(
      /gauge|monitor|station/iu,
    );
    expect(JSON.stringify(result.dashboard)).toContain("27,633");
  });

  it.each([
    ["empty", "   "],
    ["over the length limit", "x".repeat(REQUEST_MAX_LENGTH + 1)],
  ])("refuses a request that is %s", async (_label, text) => {
    const result = await planDashboard(text);

    expect(result.ok).toBe(false);
    expect(result.dashboard).toBeUndefined();
  });
});

describe("refineDashboard", () => {
  it("refuses refinement for the deterministic enrollment snapshot", async () => {
    const plan = await firstPlan();
    const result = await refineDashboard(
      "Current student enrollment at UC Riverside",
      "Show the ten-year trend",
      plan,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("cannot be refined yet");
  });

  it("applies a change to the plan it was given", async () => {
    const plan = await firstPlan();

    const result = await refineDashboard(DEFAULT_REQUEST, "Drop the map", plan);

    expect(result.ok).toBe(true);
    expect(result.plan?.pages.flatMap((page) => page.sections)).not.toContain(
      "gauge-map",
    );
    expect(
      result.dashboard?.pages.flatMap((page) => page.components),
    ).not.toContainEqual(expect.objectContaining({ kind: "station-map" }));
  });

  it("says so when it could not interpret the change", async () => {
    const plan = await firstPlan();

    const result = await refineDashboard(
      DEFAULT_REQUEST,
      "Make it feel more optimistic",
      plan,
    );

    expect(result.ok).toBe(true);
    expect(result.refinement).toBe("not-understood");
  });

  it("reports nothing when something actually changed", async () => {
    const plan = await firstPlan();

    const result = await refineDashboard(DEFAULT_REQUEST, "Drop the map", plan);

    expect(result.refinement).toBeUndefined();
  });

  it("does not call an understood-but-already-true change a failure", async () => {
    // The shipped suggestion chip, on the dashboard it ships with. The plan
    // comes back identical because the chart is already there — telling the
    // reader Dasher did not understand would be false, and it is the first
    // thing a new visitor sees.
    const plan = await firstPlan();
    const sections = (
      plan as { pages: { sections: string[] }[] }
    ).pages.flatMap((page) => page.sections);
    expect(sections).toContain("stage-trends");

    const result = await refineDashboard(
      DEFAULT_REQUEST,
      "Add the history chart",
      plan,
    );

    expect(result.ok).toBe(true);
    expect(result.refinement).toBe("already-satisfied");
  });

  it.each([
    ["empty", "   "],
    ["over the length limit", "x".repeat(REFINEMENT_MAX_LENGTH + 1)],
  ])("refuses an instruction that is %s", async (_label, instruction) => {
    const plan = await firstPlan();

    const result = await refineDashboard(DEFAULT_REQUEST, instruction, plan);

    expect(result.ok).toBe(false);
    expect(result.dashboard).toBeUndefined();
  });
});

describe("the previous plan is parsed, not trusted", () => {
  it.each([
    ["null", null],
    ["a string", "not a plan"],
    ["an object of the wrong shape", { pages: [] }],
    [
      "a plan with an unknown section",
      {
        planVersion: "plan-v1",
        title: "t",
        audience: "a",
        framing: "f",
        siteIds: ["11446500"],
        pages: [
          {
            id: "p",
            title: "P",
            description: "D",
            sections: ["flood-probability-model"],
          },
        ],
      },
    ],
  ])(
    "refuses %s rather than planning from it",
    async (_label, previousPlan) => {
      const result = await refineDashboard(
        DEFAULT_REQUEST,
        "Drop the map",
        previousPlan,
      );

      expect(result.ok).toBe(false);
      expect(result.dashboard).toBeUndefined();
    },
  );

  it("rejects a smuggled measurement even from a plan it accepted before", async () => {
    // The realistic attack on this endpoint: take a plan the server issued,
    // edit one string, hand it back. The schema accepts the shape — every field
    // is a legal string — and the free-text gate is what refuses it.
    const plan = await firstPlan();

    const result = await refineDashboard(DEFAULT_REQUEST, "Drop the map", {
      ...plan,
      title: "Sacramento at 12.4 ft",
    });

    expect(result.ok).toBe(false);
    expect(result.dashboard).toBeUndefined();
    expect(result.plan).toBeUndefined();
    // The error quotes the offending text back, which is the right thing: it
    // tells the reader what was refused. What must not exist is a dashboard
    // carrying it, and there is none — nothing rendered.
    expect(result.error).toContain("may not carry a measurement");
  });

  it("computes its own numbers regardless of the plan handed back", async () => {
    const plan = await firstPlan();
    const untouched = await refineDashboard(
      DEFAULT_REQUEST,
      "Drop the map",
      plan,
    );
    const relabelled = await refineDashboard(DEFAULT_REQUEST, "Drop the map", {
      ...plan,
      title: "Everything Is Fine",
      framing: "All calm.",
    });

    const readings = (result: typeof untouched) =>
      result.dashboard?.pages
        .flatMap((page) => page.components)
        .filter((component) => component.kind === "station-table")
        .flatMap((component) =>
          component.kind === "station-table" ? component.stations : [],
        )
        .map((station) => [
          station.id,
          station.primary.value,
          station.direction,
        ]);

    expect(readings(relabelled)).toStrictEqual(readings(untouched));
    expect(relabelled.dashboard?.title).toBe("Everything Is Fine");
  });
});

describe("the badge tells the truth about where readings came from", () => {
  // THE BUG THIS SLICE FIXES. Every builder wrote `dataMode: "demo"` as a
  // literal, so the shell's `dataMode === "live"` branch was unreachable and a
  // genuinely live-sourced dashboard still badged itself "Demo dashboard" —
  // the badge carried no information at all.
  it("says demo in fixture mode", async () => {
    const result = await planDashboard(DEFAULT_REQUEST, { persist: false });
    expect(result.ok).toBe(true);
    expect(result.dashboard?.dataMode).toBe("demo");
  });

  it("says live when the readings actually came from upstream", async () => {
    // Live mode with a real payload: the snapshot reports its own origin and
    // the spec inherits it. Before the fix this returned "demo" too, which is
    // what made the badge meaningless.
    const previousMode = process.env["DASHER_SOURCE_MODE"];
    const originalFetch = globalThis.fetch;
    process.env["DASHER_SOURCE_MODE"] = "live";
    clearSourceCache();
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(riverFixture), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    try {
      const result = await planDashboard(DEFAULT_REQUEST, { persist: false });
      expect(result.ok).toBe(true);
      expect(result.dashboard?.dataMode).toBe("live");
    } finally {
      globalThis.fetch = originalFetch;
      clearSourceCache();
      if (previousMode === undefined) delete process.env["DASHER_SOURCE_MODE"];
      else process.env["DASHER_SOURCE_MODE"] = previousMode;
    }
  });
});

describe("when a request does not need a sensor source", () => {
  it("contacts no upstream source for known-source, unsupported, or ambiguous requests", async () => {
    // Routing decides before anything is fetched. A request the product
    // cannot place must not cost an upstream call — and in live mode, must
    // not be able to blame the source for its refusal either.
    const previousMode = process.env["DASHER_SOURCE_MODE"];
    process.env["DASHER_SOURCE_MODE"] = "live";
    const fetchSpy = vi.fn();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    try {
      const enrollment = await planDashboard("UC Riverside enrollment", {
        persist: false,
      });
      const unsupported = await planDashboard("stock prices for tomorrow", {
        persist: false,
      });
      // Still ambiguous after river+air became a supported pair: enrollment
      // beside a sensor domain has no shape to compose into.
      const ambiguous = await planDashboard(
        "compare UCR enrollment with Sacramento air quality",
        { persist: false },
      );

      expect(enrollment.ok).toBe(true);
      expect(unsupported.ok).toBe(false);
      expect(ambiguous.ok).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
      if (previousMode === undefined) delete process.env["DASHER_SOURCE_MODE"];
      else process.env["DASHER_SOURCE_MODE"] = previousMode;
    }
  });

  it("refuses and persists nothing when the live source is unavailable", async () => {
    const previousMode = process.env["DASHER_SOURCE_MODE"];
    process.env["DASHER_SOURCE_MODE"] = "live";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () => new Response("nope", { status: 503 }),
    ) as unknown as typeof fetch;

    try {
      const result = await planDashboard(
        "Show me river conditions near Sacramento",
        { persist: false },
      );

      expect(result.ok).toBe(false);
      expect(result.error).toContain(
        "Live river data is temporarily unavailable",
      );
      // No dashboard, so nothing downstream could persist one.
      expect(result.dashboard).toBeUndefined();
      expect(result.dashboardId).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
      if (previousMode === undefined) delete process.env["DASHER_SOURCE_MODE"];
      else process.env["DASHER_SOURCE_MODE"] = previousMode;
    }
  });
});

describe("one request, two trusted sources", () => {
  const COMBINED = "Compare river conditions and air quality near Sacramento";

  it("builds one dashboard carrying both sources, each under its own rules", async () => {
    const result = await planDashboard(COMBINED, { persist: false });

    expect(result.ok).toBe(true);
    const dashboard = result.dashboard;
    if (dashboard === undefined) throw new Error("expected a dashboard");

    // Both halves present, and separable: every page belongs to exactly one
    // source, so nothing was blended into a third thing.
    const pageIds = dashboard.pages.map((page) => page.id);
    expect(pageIds.some((id) => id.startsWith("river:"))).toBe(true);
    expect(pageIds.some((id) => id.startsWith("air:"))).toBe(true);
    expect(
      pageIds.filter(
        (id) => !id.startsWith("river:") && !id.startsWith("air:"),
      ),
    ).toEqual([]);

    // And the composed surfaces name both, rather than one standing in for
    // the pair.
    expect(dashboard.notice).toContain("River");
    expect(dashboard.notice).toContain("Air quality");
  });

  it("leaves the single-source journeys exactly as they were", async () => {
    // The router gained a branch; the two existing ones must not have moved.
    const river = await planDashboard(
      "Show me river conditions near Sacramento",
      {
        persist: false,
      },
    );
    const air = await planDashboard("Sacramento air quality", {
      persist: false,
    });

    expect(river.ok).toBe(true);
    expect(air.ok).toBe(true);
    expect(river.dashboard?.id).toBe("planned-river-conditions");
    expect(air.dashboard?.id).toBe("planned-air-quality-conditions");
    // Single-source dashboards are not namespaced: composition is the only
    // thing that prefixes ids, and it did not run here.
    expect(river.dashboard?.pages.every((page) => !page.id.includes(":"))).toBe(
      true,
    );
    expect(air.dashboard?.pages.every((page) => !page.id.includes(":"))).toBe(
      true,
    );
  });

  it.each([
    ["river", "River", "Air quality"],
    ["air", "Air quality", "River"],
  ])(
    "keeps what loaded and names what did not when %s is unavailable",
    async (failing, absentLabel, shownLabel) => {
      // One source down, the OTHER genuinely working. An earlier version of
      // this test returned an unparseable body for the healthy host, so both
      // sources failed and it proved nothing about independence — the
      // assertion that the result names one domain and NOT the other is what
      // exposed that. Failing the domain at the source-runtime seam keeps the
      // healthy half on its real fixture instead of a hand-rolled stand-in for
      // two upstream protocols.
      //
      // This used to refuse. Refusing was truthful and too blunt: it threw
      // away a working dashboard over a fault in a part the reader may not
      // even have been looking at.
      unavailableDomains = [failing as "river" | "air"];
      try {
        const result = await planDashboard(COMBINED, { persist: false });
        const dashboard = result.dashboard;

        expect(result.ok).toBe(true);
        if (dashboard === undefined) throw new Error("expected a dashboard");

        // What is on the page is the healthy source, and only it. Nothing was
        // substituted for the source that failed.
        const prefix = failing === "river" ? "air:" : "river:";
        expect(dashboard.pages.length).toBeGreaterThan(0);
        expect(
          dashboard.pages.every((page) => page.id.startsWith(prefix)),
        ).toBe(true);

        // THE TITLE DOES NOT OVERCLAIM. Asserted as an exact string, because
        // `toContain("River")` is equally satisfied by the title a silent
        // partial would carry.
        expect(dashboard.title).toBe(
          `${shownLabel} — ${absentLabel} unavailable`,
        );

        // And the absence is stated, in the footer that renders on every page
        // and in the brief.
        expect(dashboard.notice).toContain(
          `${absentLabel} could not be loaded when this dashboard was built`,
        );
        expect(dashboard.notice).toContain("nothing here was substituted");
        expect(dashboard.executiveBrief.known.detail).toContain(
          `${absentLabel}: unavailable when this dashboard was built.`,
        );

        // IN THE ORDER THE READER ASKED. This it.each already ran both outage
        // directions and asserted only that the absent label APPEARED, which
        // is equally true of an absence appended to the end — and appended is
        // what shipped. These positional assertions are what separate them;
        // the composer's own suite pins the complete exact strings.
        const first = failing === "river" ? absentLabel : shownLabel;
        const second = failing === "river" ? shownLabel : absentLabel;
        expect(dashboard.freshness.label.startsWith(`${first}: `)).toBe(true);
        expect(dashboard.freshness.label).toContain(` · ${second}: `);
        expect(dashboard.executiveBrief.known.detail).toMatch(
          new RegExp(`^${first}: `, "u"),
        );

        // The machine-readable half, for a reader who never reaches the
        // footer. NOT asserted on `status` here: the two committed fixtures
        // differ in age, so a whole river-and-air dashboard is already
        // `partial` and the field could not tell the two apart. The
        // discriminating version of that assertion lives in the composer's own
        // suite, where the fixtures can be made equally fresh. What separates
        // them HERE is the page-level observation time, which a partial has to
        // give up rather than date the page from the source that reported.
        expect(dashboard.freshness.latestObservationAt).toBeUndefined();
        expect(dashboard.freshness.label).toContain(
          `${absentLabel}: unavailable`,
        );
      } finally {
        unavailableDomains = [];
      }
    },
  );

  it("still refuses when no source loads, because that is a refusal", async () => {
    // The floor. An honest partial needs something to be partial ABOUT; a page
    // of nothing but absences is a refusal wearing a dashboard's clothes.
    unavailableDomains = ["river", "air"];
    try {
      const result = await planDashboard(COMBINED, { persist: false });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("temporarily unavailable");
      expect(result.error).toContain("river");
      expect(result.error).toContain("air-quality");
      expect(result.dashboard).toBeUndefined();
      expect(result.dashboardId).toBeUndefined();
    } finally {
      unavailableDomains = [];
    }
  });

  it("names both sources in the title when both load", async () => {
    // The counterweight to the partial title. Without it, a title rule that
    // ALWAYS said "unavailable" would pass every assertion above.
    const result = await planDashboard(COMBINED, { persist: false });

    expect(result.dashboard?.title).toBe(
      "River and Air quality — combined conditions",
    );
    expect(result.dashboard?.notice).not.toContain("substituted");
    expect(result.dashboard?.freshness.latestObservationAt).toBeDefined();
    expect(result.dashboard?.freshness.label).not.toContain("unavailable");
  });

  it("says the pair cannot be combined, not that the reader should reword", async () => {
    // Both halves built; the PAIR is what failed. Before this, the contract's
    // rejection escaped as a raw `ZodError`, was caught as an unknown fault,
    // and came back as "Try rewording it" — advice that cannot work, because
    // no phrasing makes two dashboards fit inside one budget. The message must
    // point at the thing that WILL succeed.
    composeRefuses = true;
    try {
      const result = await planDashboard(COMBINED, { persist: false });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("could not combine");
      expect(result.error).toMatch(/on its own/u);
      expect(result.error).not.toMatch(/reword/iu);
      expect(result.dashboard).toBeUndefined();
      expect(result.dashboardId).toBeUndefined();
    } finally {
      composeRefuses = false;
    }
  });

  it("still reaches the generic message for a fault that is not a refusal", async () => {
    // The counterweight, and it has to throw something REAL to be one. An
    // earlier version of this test just ran the happy path and asserted it
    // passed, which says nothing about the branch it claims to cover — the
    // same hollow shape this slice has now produced twice. Recognising
    // `DashboardCompositionError` must not widen into treating every failure
    // as an uncombinable pair, or a genuine bug is reported to the reader as
    // a property of their request.
    composeFaults = true;
    try {
      const result = await planDashboard(COMBINED, { persist: false });

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/reword/iu);
      expect(result.error).not.toContain("could not combine");
    } finally {
      composeFaults = false;
    }
  });

  it("refuses to refine a combined dashboard rather than half-refining it", async () => {
    const built = await planDashboard(COMBINED, { persist: false });
    expect(built.ok).toBe(true);

    const refined = await refineDashboard(COMBINED, "Add a trend chart", {
      planVersion: "plan-v1",
      title: "T",
      audience: "A",
      framing: "F",
      siteIds: ["11447650"],
      pages: [
        {
          id: "overview",
          title: "Overview",
          description: "D",
          sections: ["conditions-summary"],
        },
      ],
    });
    expect(refined.ok).toBe(false);
    expect(refined.error).toContain("combined dashboard cannot be refined");
  });
});

/**
 * The upload path, and the rule that separates it from every other source.
 *
 * A river gauge can be read again tomorrow and the enrollment snapshot is
 * committed to this repository, so a dashboard built from either can be shown
 * whether or not it was saved. An uploaded file exists once, inside the request
 * that carried it. A dashboard built from one and not stored would state
 * figures whose only source had been discarded, and would look identical to one
 * whose evidence is intact — so the upload refuses instead.
 *
 * These run with no database configured, which is exactly the deployment that
 * has nowhere to put the file. The path that does store it is proven against a
 * real Postgres in `@dasher/control-plane` and end to end in the persistence
 * job.
 */
describe("uploadLedgerDashboard", () => {
  const CSV =
    "line_id,label,budget_per_period,2026-03,2026-04\r\ncloud,Cloud,100,10,20\r\n";

  const form = (
    overrides: Record<string, string | File | undefined> = {},
  ): FormData => {
    const data = new FormData();
    const fields: Record<string, string | File | undefined> = {
      file: new File([CSV], "operating-spend.csv", { type: "text/csv" }),
      request: "operating spend by category",
      sourceName: "Finance export",
      currency: "USD",
      periodLabel: "month",
      exportedOn: "2026-08-24",
      ...overrides,
    };
    for (const [name, value] of Object.entries(fields)) {
      if (value !== undefined) data.set(name, value);
    }
    return data;
  };

  it("refuses when there is nowhere durable to keep the file", async () => {
    // The whole point of the slice, stated as a refusal: no database means no
    // evidence, and no evidence means no dashboard. Note what does NOT happen —
    // a dashboard is not returned with a warning beside it, which is what the
    // typed path does when a save fails.
    const result = await uploadLedgerDashboard(form());

    expect(result.ok).toBe(false);
    expect(result.dashboard).toBeUndefined();
    expect(result.error).toMatch(/nowhere to keep them/u);
  });

  it("asks for a file before anything else", async () => {
    const result = await uploadLedgerDashboard(form({ file: undefined }));

    expect(result.error).toMatch(/Choose a CSV export/u);
  });

  it("treats an empty file as no file", async () => {
    // A file input can hand over a zero-byte file, and "that file has no rows
    // in it" is a worse answer than asking for one.
    const result = await uploadLedgerDashboard(
      form({ file: new File([], "empty.csv", { type: "text/csv" }) }),
    );

    expect(result.error).toMatch(/Choose a CSV export/u);
  });

  it("refuses a file past the limit without reading it", async () => {
    const result = await uploadLedgerDashboard(
      form({
        file: new File([new Uint8Array(UPLOAD_MAX_BYTES + 1)], "huge.csv", {
          type: "text/csv",
        }),
      }),
    );

    expect(result.error).toMatch(/bigger than the 4 MB/u);
  });

  it("checks the declared details before it reads the bytes", async () => {
    // Ordering that matters: a file with a missing currency is refused for the
    // missing currency, not parsed first and refused for it afterwards.
    const result = await uploadLedgerDashboard(form({ currency: "" }));

    expect(result.error).toMatch(/three letters/u);
  });

  it("does not run the domain router over the brief", async () => {
    // The typed path asks what subject a sentence is about, and would refuse
    // this one. Choosing the upload form has already answered that question —
    // running the classifier could only refuse a file somebody explicitly
    // handed over.
    const result = await uploadLedgerDashboard(
      form({ request: "show me the numbers" }),
    );

    expect(result.error).not.toMatch(/river conditions, air quality/u);
    expect(result.error).toMatch(/nowhere to keep them/u);
  });
});
