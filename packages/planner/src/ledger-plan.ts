import { z } from "zod";

import { findSmuggledText } from "./freetext";

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
  code:
    | "unknown_line"
    | "no_lines"
    | "duplicate_section"
    | "free_text_measurement"
    | "free_text_directive";
  message: string;
  /** Which field, for the two findings that have one. */
  path?: string;
}

/**
 * Check a plan against the ledger that actually exists.
 *
 * The station path calls this `findPlanProblems` and checks the same four kinds
 * of thing: that every selected subject exists, that at least one survives,
 * that no section is asked for twice, and that no free-text field carries a
 * measurement or an instruction. A model that invents a budget line is the
 * ledger's version of one that invents a gauge, and it is caught the same way —
 * by comparing against the snapshot rather than by trusting the plan.
 *
 * THE FOURTH CHECK WAS MISSING AND THE COMMENT ABOVE ALREADY CLAIMED IT. This
 * file's header said the free-text fields "go through the same gate the station
 * plan's do" while `findSmuggledText` was typed to `DashboardPlan` and could not
 * be called with a ledger plan at all. The same text that produced four findings
 * on a station plan produced none here.
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

  for (const smuggled of findSmuggledText(plan)) {
    findings.push(
      smuggled.kind === "measurement"
        ? {
            code: "free_text_measurement",
            path: smuggled.path,
            message: `Free text may not carry a measurement, and "${smuggled.excerpt}" is one. Dasher computes and displays every figure itself from the ledger; describe the composition instead and leave the amounts to the dashboard.`,
          }
        : {
            code: "free_text_directive",
            path: smuggled.path,
            message: `Free text may not instruct the reader to act, and "${smuggled.excerpt}" does. Dasher has no basis for an instruction and no evidence record that could support one; describe what the dashboard shows instead.`,
          },
    );
  }

  return findings;
}
