import { describe, expect, it } from "vitest";

import { periodsInSpan, suggestGrain } from "./parse-values";

/**
 * The analysis bucket follows how much time a file covers, and nothing else.
 * Read coarsest-first, so a long file settles on a coarse bucket before it can
 * reach a fine one — five years of daily rows are five yearly buckets, never
 * eighteen hundred daily ones.
 */
describe("choosing a bucket for a span", () => {
  it.each([
    { span: ["2026-08-24", "2026-09-02"], grain: "day", why: "ten days" },
    { span: ["2026-02-01", "2026-03-14"], grain: "week", why: "six weeks" },
    { span: ["2026-01-05", "2026-03-09"], grain: "week", why: "ten weeks" },
    { span: ["2026-01-02", "2026-08-25"], grain: "month", why: "eight months" },
    {
      span: ["2024-01-01", "2026-08-25"],
      grain: "quarter",
      why: "three years",
    },
    { span: ["2021-01-01", "2026-08-25"], grain: "year", why: "six years" },
    { span: ["2026-03-01", "2026-03-01"], grain: "month", why: "a single day" },
    { span: ["2026-01-15", "2026-02-15"], grain: "week", why: "one month" },
    // Too short to shape at any grain: one bucket holding them together beats
    // one bucket each, which aggregates nothing.
    { span: ["2026-01-01", "2026-01-03"], grain: "month", why: "three days" },
    { span: ["2026-01-01", "2026-01-04"], grain: "month", why: "four days" },
    { span: ["2026-01-01", "2026-01-07"], grain: "day", why: "a full week" },
    {
      span: ["2026-01-01", "2026-01-27"],
      grain: "day",
      why: "under four weeks",
    },
  ])("reads $why as $grain", ({ span, grain }) => {
    expect(suggestGrain(span[0] as string, span[1] as string)).toBe(grain);
  });

  it("counts buckets inclusively at every grain", () => {
    // 2026-02-01 is a Sunday, in the ISO week starting 2026-01-26.
    expect(periodsInSpan("2026-02-01", "2026-03-14", "day")).toBe(42);
    expect(periodsInSpan("2026-02-01", "2026-03-14", "week")).toBe(7);
    expect(periodsInSpan("2026-02-01", "2026-03-14", "month")).toBe(2);
    expect(periodsInSpan("2026-01-02", "2026-08-25", "month")).toBe(8);
    expect(periodsInSpan("2026-01-02", "2026-08-25", "quarter")).toBe(3);
    expect(periodsInSpan("2026-01-02", "2026-08-25", "year")).toBe(1);
    expect(periodsInSpan("2025-12-31", "2026-01-01", "year")).toBe(2);
  });

  it("never reports a bucket for a backwards or unreadable span", () => {
    expect(periodsInSpan("2026-08-25", "2026-01-02", "month")).toBe(0);
    expect(periodsInSpan("not-a-date", "2026-01-02", "month")).toBe(0);
  });
});
