// @ts-nocheck
import { z } from "zod";

/**
 * What a planner may say about a ledger dashboard.
 *
 * This is a second plan contract, not a widening of the first. `DashboardPlan`
 * selects by `siteIds` and offers sections named `gauge-map` and `gauge-table`;
 * a ledger has neither sites nor a map, and making one schema serve both would
 * mean every field being optional and every validator asking which source it
 * was looking at. Two small contracts that share a shape are cheaper to read
 * than one that means different things on different days.
 *
 * What the two DO share is the property that matters: a plan carries
 * composition only. Every number on the finished dashboard is computed by the
 * compiler from the snapshot. There is nowhere in this object to put an amount,
 * and the free-text fields go through the same gate the station plan's do.
 */

export const LEDGER_PLAN_MAX_PAGES = 3;
export const LEDGER_PLAN_MAX_SECTIONS_PER_PAGE = 5;

/**
 * The closed set of ledger sections.
 *
 * Deliberately not the station set with the map removed. A section name is what
 * a planner reasons with, and "fastest-rising" is a sensor's idea of interest
 * while a ledger's is "what moved". These five map onto five of the seven
 * contract components — the two left out are `station-map` and `station-table`,
 * which is the whole point.
 */
export const LEDGER_SECTION_KINDS = [
  "spend-summary",
  "headline-totals",
  "largest-movers",
  "line-trends",
  "over-budget",
] as const;

export type LedgerSectionKind = (typeof LEDGER_SECTION_KINDS)[number];

const IdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9-]+$/u, "ids are lowercase kebab-case");

export const LedgerPlanSchema = z.strictObject({
  planVersion: z.literal("ledger-plan-v1"),
  title: z.string().min(1).max(120),
  audience: z.string().min(1).max(120),
  framing: z.string().min(1).max(400),
  /**
   * Which ledger lines to include, in display order. The station plan's
   * `siteIds` with a different name is exactly what this is not: a line id
   * names a category in a book of account, and nothing about it is a location.
   */
  lineIds: z.array(IdSchema).min(1).max(50),
  pages: z
    .array(
      z.strictObject({
        id: IdSchema,
        title: z.string().min(1).max(120),
        description: z.string().min(1).max(400),
        sections: z
          .array(z.enum(LEDGER_SECTION_KINDS))
          .min(1)
          .max(LEDGER_PLAN_MAX_SECTIONS_PER_PAGE),
      }),
    )
    .min(1)
    .max(LEDGER_PLAN_MAX_PAGES),
});

export type LedgerPlan = z.infer<typeof LedgerPlanSchema>;

export interface LedgerPlanFinding {
  code: "unknown_line" | "no_lines" | "duplicate_section";
  message: string;
}

/**
 * Check a plan against the ledger that actually exists.
 *
 * The station path calls this `findPlanProblems` and checks the same three
 * kinds of thing: that every selected subject exists, that at least one
 * survives, and that no section is asked for twice. A model that invents a
 * budget line is the ledger's version of one that invents a gauge, and it is
 * caught the same way — by comparing against the snapshot rather than by
 * trusting the plan.
 */
export function findLedgerPlanProblems(
  plan: LedgerPlan,
  knownLineIds: readonly string[],
): LedgerPlanFinding[] {
  const findings: LedgerPlanFinding[] = [];
  const known = new Set(knownLineIds);

  for (const lineId of plan.lineIds) {
    if (!known.has(lineId)) {
      findings.push({
        code: "unknown_line",
        message: `The ledger has no line "${lineId}". Choose only from the lines you were given.`,
      });
    }
  }

  if (!plan.lineIds.some((lineId) => known.has(lineId))) {
    findings.push({
      code: "no_lines",
      message: "No line in this plan exists in the ledger.",
    });
  }

  const seen = new Set<LedgerSectionKind>();
  for (const page of plan.pages) {
    for (const section of page.sections) {
      if (seen.has(section)) {
        findings.push({
          code: "duplicate_section",
          message: `Section "${section}" appears more than once. Use each at most once across the whole plan.`,
        });
      }
      seen.add(section);
    }
  }

  return findings;
}
