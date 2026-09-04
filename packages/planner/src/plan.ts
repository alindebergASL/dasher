/**
 * Checks a parsed plan against the table it will be compiled from. A plan
 * that names a column the table lacks, asks for a section its roles cannot
 * support, or writes a figure into reader-facing text is returned as findings
 * the planner can repair, never compiled.
 */
import {
  parsePeriodHeader,
  type ColumnProfile,
  type ColumnType,
  type Table,
} from "./workbook";
import type { TablePlan, TableSectionKind } from "./table-plan";

export type PlanFindingCode =
  | "unknown_column"
  | "role_type"
  | "section_needs_role"
  | "duplicate_section"
  | "duplicate_page_id"
  | "free_text_measurement"
  | "empty_after_filters"
  | "plan_malformed"
  | "spec_rejected";

export interface PlanFinding {
  readonly code: PlanFindingCode;
  /** Dot path into the plan, e.g. `roles.amount` or `pages[1].sections[0]`. */
  readonly path: string;
  readonly message: string;
}

export class PlanRejected extends Error {
  constructor(readonly findings: readonly PlanFinding[]) {
    super(
      findings.length === 0
        ? "The plan was rejected."
        : `The plan was rejected: ${findings.map((finding) => `${finding.path}: ${finding.message}`).join("; ")}`,
    );
    this.name = "PlanRejected";
  }
}

type RoleName = keyof TablePlan["roles"];

const ROLE_NEEDS: Readonly<Partial<Record<TableSectionKind, RoleName[]>>> = {
  "by-category": ["category"],
  movers: ["category", "period"],
  trend: ["period"],
  "budget-variance": ["budget"],
};

/** RULE: every role states the column type it can read; period has its own test. */
const ROLE_TYPE: Readonly<Partial<Record<RoleName, ColumnType>>> = {
  amount: "number",
  budget: "number",
  category: "text",
  label: "text",
  account: "text",
};

/** A column that can play the period role: a date, or cells that name periods. */
export function isPeriodColumn(column: ColumnProfile, table: Table): boolean {
  if (column.type === "date") return true;
  if (
    table.unpivoted !== undefined &&
    column.name === table.unpivoted.periodColumn
  ) {
    return true;
  }
  const filled = column.samples.filter((sample) => sample !== "");
  return (
    filled.length > 0 &&
    filled.every((sample) => parsePeriodHeader(sample) !== null)
  );
}

function checkRoles(
  plan: TablePlan,
  table: Table,
  findings: PlanFinding[],
): void {
  const byName = new Map(table.columns.map((column) => [column.name, column]));
  for (const [role, name] of Object.entries(plan.roles) as [
    RoleName,
    string | undefined,
  ][]) {
    if (name === undefined) continue;
    const column = byName.get(name);
    if (column === undefined) {
      findings.push({
        code: "unknown_column",
        path: `roles.${role}`,
        message: `The table has no column named "${name}".`,
      });
      continue;
    }
    const needed = ROLE_TYPE[role];
    if (needed !== undefined && column.type !== needed) {
      findings.push({
        code: "role_type",
        path: `roles.${role}`,
        message: `"${name}" is a ${column.type} column; the ${role} role needs a ${needed} column.`,
      });
    }
    if (role === "period" && !isPeriodColumn(column, table)) {
      findings.push({
        code: "role_type",
        path: "roles.period",
        message: `"${name}" holds neither dates nor period names such as 2026-03 or Q1 2026.`,
      });
    }
  }
  for (const [index, filter] of plan.filters.entries()) {
    if (!byName.has(filter.column)) {
      findings.push({
        code: "unknown_column",
        path: `filters[${index}].column`,
        message: `The table has no column named "${filter.column}".`,
      });
    }
  }
}

function checkPages(plan: TablePlan, findings: PlanFinding[]): void {
  const seenIds = new Set<string>();
  const seenSections = new Set<TableSectionKind>();
  for (const [pageIndex, page] of plan.pages.entries()) {
    if (seenIds.has(page.id)) {
      findings.push({
        code: "duplicate_page_id",
        path: `pages[${pageIndex}].id`,
        message: `Page id "${page.id}" is used more than once.`,
      });
    }
    seenIds.add(page.id);
    for (const [sectionIndex, section] of page.sections.entries()) {
      const path = `pages[${pageIndex}].sections[${sectionIndex}]`;
      if (seenSections.has(section)) {
        findings.push({
          code: "duplicate_section",
          path,
          message: `Section "${section}" appears more than once; each section is used at most once.`,
        });
      }
      seenSections.add(section);
      for (const role of ROLE_NEEDS[section] ?? []) {
        if (plan.roles[role] === undefined) {
          findings.push({
            code: "section_needs_role",
            path,
            message: `Section "${section}" needs a ${role} column; set roles.${role} or drop the section.`,
          });
        }
      }
    }
  }
}

/**
 * RULE: reader-facing text describes the composition; Dasher computes and
 * formats every figure.
 *
 * A bounded detector, not a proof. It masks the composition language a plan may
 * legitimately use — time windows, years, quarters, "top 5" — and then looks for
 * a figure in what is left. It sits behind the planner's prompt and in front of
 * arithmetic that never reads these strings, so what it misses is caught by the
 * fact that no figure on the page comes from them.
 */
const WORD_NUMBER =
  "(?:a|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)";

const COMPOSITION: readonly RegExp[] = [
  new RegExp(
    `\\b(?:the\\s+)?(?:last|past|previous|next|first|latest|trailing|recent)\\s+(?:\\d{1,3}|${WORD_NUMBER})\\s+(?:seconds?|minutes?|hours?|days?|weeks?|months?|quarters?|years?)\\b`,
    "giu",
  ),
  /\b(?:top|bottom|first|last|next)\s+\d{1,3}\b/giu,
  /\bfy\s?\d{2,4}\b/giu,
  /\b(?:19|20)\d{2}\b/gu,
  /\b[qh][1-4]\b/giu,
  /\b\d{1,2}(?:st|nd|rd|th)\b/giu,
];

const FIGURES: readonly RegExp[] = [
  /[$€£¥₹]\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s?(?:USD|EUR|GBP|JPY|CAD|AUD|CHF|dollars?|euros?|pounds?|cents?)\b/iu,
  /\b\d[\d,]*(?:\.\d+)?\s?(?:%|percent\b|per cent\b|pct\b)/iu,
  new RegExp(
    `\\b${WORD_NUMBER}(?:[ -]${WORD_NUMBER})?\\s+(?:percent|per cent|pct)\\b`,
    "iu",
  ),
  new RegExp(
    `\\b(?:${WORD_NUMBER}|\\d[\\d,]*(?:\\.\\d+)?)\\s?(?:hundred|thousand|million|billion|trillion|k|m|bn|mm)\\b`,
    "iu",
  ),
  /\b(?:half|halves|halved|double[ds]?|doubling|triple[ds]?|tripling|twice|quadruple[ds]?)\b/iu,
  /(?<![\w.])\d+\.\d+(?![\w.])/u,
  /\b\d{1,3}(?:,\d{3})+\b/u,
  /\b\d{2,}\b/u,
];

/** Blanks out a span, keeping every other character where it was. */
function mask(text: string): string {
  let masked = text;
  for (const pattern of COMPOSITION) {
    masked = masked.replace(pattern, (match) => " ".repeat(match.length));
  }
  return masked;
}

/**
 * A figure in text the reader sees verbatim, as it reads in the original.
 * Time windows ("last 12 months"), years, quarters and ranks ("top 5") carry no
 * figure and are allowed.
 */
export function findMeasurement(text: string): string | undefined {
  const masked = mask(text);
  for (const pattern of FIGURES) {
    const match = pattern.exec(masked);
    if (match !== null)
      return text.slice(match.index, match.index + match[0].length);
  }
  return undefined;
}

export function planFreeText(
  plan: TablePlan,
): { path: string; text: string }[] {
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

function checkFreeText(plan: TablePlan, findings: PlanFinding[]): void {
  for (const { path, text } of planFreeText(plan)) {
    const excerpt = findMeasurement(text);
    if (excerpt !== undefined) {
      findings.push({
        code: "free_text_measurement",
        path,
        message: `"${excerpt}" reads as a figure. Describe the composition; Dasher computes every number.`,
      });
    }
  }
}

/** Every problem with a well-formed plan, in plan order. Empty means compilable. */
export function findPlanProblems(plan: TablePlan, table: Table): PlanFinding[] {
  const findings: PlanFinding[] = [];
  checkRoles(plan, table, findings);
  checkPages(plan, findings);
  checkFreeText(plan, findings);
  return findings;
}
