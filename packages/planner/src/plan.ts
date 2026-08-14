import { z } from "zod";

import { findSmuggledText } from "./freetext";

/**
 * The `DashboardPlan` is the only structure a planning model is permitted to
 * emit. It carries composition and framing decisions — what the dashboard is
 * called, who it is for, which gauges are in scope, and how the pages are laid
 * out — and it carries no facts.
 *
 * Every number, evidence item, freshness state, and claim on the rendered
 * dashboard is computed by `compilePlan` from the observations. No field of
 * this schema is a place to put a reading.
 *
 * That last sentence used to read "a model cannot assert a measurement through
 * this contract because there is nowhere in it to put one", and it was false as
 * written. `title`, `audience`, `framing`, and the page headings are free text
 * rendered verbatim, so a plan titled "Sacramento at 12.4 ft" asserted a reading
 * that no field was named for. The shape of the object was doing the arguing;
 * the strings inside it were unexamined. `findPlanProblems` now checks them —
 * see `freetext.ts` for exactly which categories are caught and which are
 * knowingly not.
 */

export const PLAN_MAX_PAGES = 4;
export const PLAN_MAX_SECTIONS_PER_PAGE = 6;
export const PLAN_MAX_SITES = 50;

export const PLAN_STRING_LIMITS = {
  id: 64,
  shortText: 256,
  longText: 1_024,
} as const;

/**
 * The closed set of sections the trusted compiler knows how to build. A plan
 * naming anything outside this list is rejected, so an unsupported or invented
 * section can never reach the renderer.
 */
export const PLAN_SECTION_KINDS = [
  "conditions-summary",
  "headline-metrics",
  "gauge-map",
  "fastest-rising",
  "attention",
  "gauge-table",
  "stage-trends",
  "change-windows",
] as const;

export type PlanSectionKind = (typeof PLAN_SECTION_KINDS)[number];

const PlanIdSchema = z
  .string()
  .min(1)
  .max(PLAN_STRING_LIMITS.id)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Plan IDs must be lowercase kebab-case");

const PlanPageSchema = z.strictObject({
  id: PlanIdSchema,
  title: z.string().min(1).max(PLAN_STRING_LIMITS.shortText),
  description: z.string().min(1).max(PLAN_STRING_LIMITS.longText),
  sections: z
    .array(z.enum(PLAN_SECTION_KINDS))
    .min(1)
    .max(PLAN_MAX_SECTIONS_PER_PAGE),
});

export const DashboardPlanSchema = z.strictObject({
  planVersion: z.literal("plan-v1"),
  title: z.string().min(1).max(PLAN_STRING_LIMITS.shortText),
  audience: z.string().min(1).max(PLAN_STRING_LIMITS.shortText),
  /** One sentence of narrative framing, shown as the summary subtitle. */
  framing: z.string().min(1).max(PLAN_STRING_LIMITS.longText),
  /** USGS site IDs to include, in display order. */
  siteIds: z
    .array(z.string().min(1).max(PLAN_STRING_LIMITS.id))
    .max(PLAN_MAX_SITES),
  pages: z.array(PlanPageSchema).min(1).max(PLAN_MAX_PAGES),
});

export type DashboardPlan = z.infer<typeof DashboardPlanSchema>;
export type PlanPage = z.infer<typeof PlanPageSchema>;

/**
 * A structured rejection. These are fed back to the provider verbatim so a
 * revision pass can repair the plan without a human in the loop, and they are
 * the only channel by which validation influences a model.
 */
export type PlanFindingCode =
  | "plan_malformed"
  | "unknown_site"
  | "no_known_sites"
  | "duplicate_site"
  | "duplicate_page_id"
  | "duplicate_section"
  | "section_needs_sites"
  | "free_text_measurement"
  | "free_text_directive"
  | "spec_rejected";

export interface PlanFinding {
  code: PlanFindingCode;
  /** Dot path into the plan, e.g. `siteIds[2]` or `pages[0].sections[1]`. */
  path: string;
  message: string;
}

export class PlanRejected extends Error {
  readonly findings: readonly PlanFinding[];

  constructor(findings: readonly PlanFinding[]) {
    super(
      `Plan rejected: ${findings.map((finding) => finding.code).join(", ")}`,
    );
    this.name = "PlanRejected";
    this.findings = findings;
  }
}

/**
 * Sections that describe individual gauges and therefore cannot render from an
 * empty selection. `attention` and `conditions-summary` are excluded: both stay
 * meaningful when no gauge qualifies, and both say so explicitly.
 */
const SECTIONS_REQUIRING_SITES = new Set<PlanSectionKind>([
  "gauge-map",
  "gauge-table",
  "stage-trends",
  "change-windows",
]);

/**
 * Structural validation of a plan against the observations actually available.
 * Returns findings rather than throwing so the caller can decide whether to
 * request a revision or fail.
 */
export function findPlanProblems(
  plan: DashboardPlan,
  knownSiteIds: readonly string[],
): PlanFinding[] {
  const findings: PlanFinding[] = [];
  const known = new Set(knownSiteIds);
  const seenSites = new Set<string>();

  for (const [index, siteId] of plan.siteIds.entries()) {
    if (!known.has(siteId)) {
      findings.push({
        code: "unknown_site",
        path: `siteIds[${index}]`,
        message: `Site ${siteId} is not present in the available observations. Available sites: ${knownSiteIds.join(", ")}.`,
      });
    } else if (seenSites.has(siteId)) {
      findings.push({
        code: "duplicate_site",
        path: `siteIds[${index}]`,
        message: `Site ${siteId} is listed more than once.`,
      });
    }
    seenSites.add(siteId);
  }

  const resolvedSites = plan.siteIds.filter((siteId) => known.has(siteId));
  if (resolvedSites.length === 0) {
    findings.push({
      code: "no_known_sites",
      path: "siteIds",
      message: `No requested site is available. Choose from: ${knownSiteIds.join(", ")}.`,
    });
  }

  const seenPageIds = new Set<string>();
  const seenSections = new Set<PlanSectionKind>();

  for (const [pageIndex, page] of plan.pages.entries()) {
    if (seenPageIds.has(page.id)) {
      findings.push({
        code: "duplicate_page_id",
        path: `pages[${pageIndex}].id`,
        message: `Page id "${page.id}" is used more than once.`,
      });
    }
    seenPageIds.add(page.id);

    for (const [sectionIndex, section] of page.sections.entries()) {
      const path = `pages[${pageIndex}].sections[${sectionIndex}]`;
      if (seenSections.has(section)) {
        findings.push({
          code: "duplicate_section",
          path,
          message: `Section "${section}" already appears earlier in the plan. Each section may be used once.`,
        });
      }
      seenSections.add(section);

      if (resolvedSites.length === 0 && SECTIONS_REQUIRING_SITES.has(section)) {
        findings.push({
          code: "section_needs_sites",
          path,
          message: `Section "${section}" needs at least one available gauge.`,
        });
      }
    }
  }

  for (const smuggled of findSmuggledText(plan)) {
    findings.push(
      smuggled.kind === "measurement"
        ? {
            code: "free_text_measurement",
            path: smuggled.path,
            message: `Free text may not carry a measurement, and "${smuggled.excerpt}" is one. Dasher computes and displays every reading itself from the observations; describe the composition instead and leave the numbers to the dashboard.`,
          }
        : {
            code: "free_text_directive",
            path: smuggled.path,
            message: `Free text may not instruct the reader to act, and "${smuggled.excerpt}" does. Dasher has no basis for a safety instruction and no evidence record that could support one; describe what the dashboard shows instead.`,
          },
    );
  }

  return findings;
}
