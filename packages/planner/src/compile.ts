/**
 * Turns an accepted plan and a table into a `DashboardSpec`. Every number on
 * the result is computed here from the table's cells; the plan only says
 * which columns to read and which sections to show.
 */
import {
  parseDashboardSpec,
  type DashboardComponent,
  type DashboardSpec,
  type Evidence,
  type Page,
} from "@dasher/dashboard-schema";
import { periodLabel, sign, type Table } from "./workbook";
import {
  formatMoney,
  formatSignedMoney,
  formatSignedPercent,
  plural,
  type MoneyFormat,
} from "./arith";
import { computeFacts, type TableFacts } from "./facts";
import { PlanRejected } from "./plan";
import {
  EVIDENCE,
  RANKING_LIMIT,
  SECTION_BUILDERS,
  windowLabel,
  type SectionContext,
} from "./sections";
import type { TablePlan } from "./table-plan";

export interface CompileSource {
  readonly name: string;
  readonly retrievedAt: string;
  readonly sha256?: string;
  readonly byteLength?: number;
  readonly rowCount: number;
}

export interface CompileOptions {
  readonly asOf: string;
  readonly planner: { readonly id: string; readonly usesModel: boolean };
  readonly source: CompileSource;
}

function moneyFormat(
  plan: TablePlan,
  table: Table,
  facts: TableFacts,
): MoneyFormat {
  const currency = table.columns.find(
    (column) => column.name === plan.roles.amount,
  )?.currency;
  return {
    ...(currency === undefined ? {} : { currency }),
    decimals: facts.wholeAmounts ? 0 : 2,
  };
}

/**
 * How the shares on this page were actually produced. The allocation only sums
 * to one hundred when every category total is positive.
 */
function sharesSentence(facts: TableFacts): string | undefined {
  if (facts.shares.length === 0) return undefined;
  const how = facts.sharesSumToHundred
    ? "and are allocated in tenths of a percent so they sum to exactly one hundred"
    : sign(facts.latestTotal) === 0
      ? `and every share is reported as zero because the total for ${windowLabel(facts)} is zero`
      : "and are each rounded to a tenth of a percent on their own, because a total is negative, so they need not sum to one hundred";
  const omitted = facts.shares.length - RANKING_LIMIT;
  const cut =
    omitted > 0
      ? ` The ranking lists the largest ${String(RANKING_LIMIT)} categories; ${plural(omitted, "more is", "more are")} not shown.`
      : "";
  return `Shares divide each category's total by the period total ${how}. Movers are each category's latest total minus its previous total, ordered by size of change.${cut}`;
}

function evidence(
  plan: TablePlan,
  table: Table,
  facts: TableFacts,
  options: CompileOptions,
): Evidence[] {
  const { source } = options;
  const detail = [
    `${plural(source.rowCount, "row", "rows")} and ${plural(table.columns.length, "column", "columns")}`,
    source.byteLength === undefined
      ? undefined
      : `${String(source.byteLength)} bytes`,
    source.sha256 === undefined ? undefined : `sha256 ${source.sha256}`,
    table.unpivoted === undefined
      ? undefined
      : `one column per period (${table.unpivoted.periodColumns.join(", ")}) reshaped into one row per line and period`,
  ].filter((part) => part !== undefined);
  const arithmetic = [
    `Amounts were read from "${plan.roles.amount}" as exact decimals; ${plural(facts.skipped, "row whose amount or period could not be read was", "rows whose amount or period could not be read were")} skipped and ${plural(facts.filteredOut, "row was", "rows were")} left out by the plan's filters.`,
    plan.roles.period === undefined
      ? "There is no period column, so every figure covers the whole file."
      : `Rows were grouped by ${facts.grain} from "${plan.roles.period}".`,
    plan.lastPeriods === undefined
      ? undefined
      : `${plural(facts.outsideWindow, "row fell", "rows fell")} outside the last ${String(plan.lastPeriods)} periods and ${facts.outsideWindow === 1 ? "was" : "were"} not counted.`,
    "Totals are sums of the amounts in each group. Change is the latest period's total minus the previous period's; percent change divides that by the previous total.",
    plan.roles.category === undefined ? undefined : sharesSentence(facts),
    plan.roles.budget === undefined
      ? undefined
      : `Budget variance sums every row a line has in the latest period and subtracts the "${plan.roles.budget}" cells that line states; a positive variance is over budget.`,
  ].filter((part) => part !== undefined);
  const items: Evidence[] = [
    {
      id: EVIDENCE.source,
      kind: "observed",
      label: `Uploaded file ${source.name}`,
      sourceName: source.name,
      retrievedAt: source.retrievedAt,
      detail: detail.join("; ") + ".",
      confidence: "high",
    },
    {
      id: EVIDENCE.calculations,
      kind: "calculated",
      label: "How the figures were computed",
      sourceName: source.name,
      retrievedAt: options.asOf,
      detail: arithmetic.join(" "),
      confidence: "high",
    },
  ];
  if (options.planner.usesModel) {
    items.push({
      id: EVIDENCE.composition,
      kind: "interpreted",
      label: "How the dashboard was composed",
      sourceName: options.planner.id,
      retrievedAt: options.asOf,
      detail:
        "A planning model chose the column roles and layout; it saw column names and samples, never totals.",
      confidence: "medium",
    });
  }
  return items;
}

function brief(
  facts: TableFacts,
  money: MoneyFormat,
  ids: string[],
): DashboardSpec["executiveBrief"] {
  const window = windowLabel(facts);
  const known = {
    statementTypes: ["calculated" as const],
    headline: `${formatMoney(facts.latestTotal, money)} total for ${window}`,
    detail: `The sum of every amount in ${window}, computed from the file.`,
    evidenceIds: ids,
  };
  const changed =
    facts.change === undefined || facts.previousPeriod === undefined
      ? {
          statementTypes: ["calculated" as const],
          headline: "No prior period in this file",
          detail:
            "There is nothing earlier in the file to compare the latest period with.",
          evidenceIds: ids,
        }
      : {
          statementTypes: ["calculated" as const],
          headline: `${formatSignedMoney(facts.change, money)} vs ${periodLabel(facts.previousPeriod)}`,
          detail: `The latest total minus the previous period's total${facts.changePercent === undefined ? "" : `, a change of ${formatSignedPercent(facts.changePercent)}`}.`,
          evidenceIds: ids,
        };
  const over = facts.budget.filter((line) => line.over)[0];
  const mover = facts.movers[0];
  const largest = facts.shares[0];
  const important =
    over !== undefined
      ? {
          headline: `${over.name} is over budget by ${formatMoney(over.variance, money)}`,
          detail: `${formatMoney(over.amount, money)} spent against ${formatMoney(over.budget, money)} budgeted for ${window}.`,
        }
      : mover !== undefined && facts.previousPeriod !== undefined
        ? {
            headline: `${mover.category} moved ${formatSignedMoney(mover.change, money)}`,
            detail: `The largest change between ${periodLabel(facts.previousPeriod)} and ${window}, from ${formatMoney(mover.previous, money)} to ${formatMoney(mover.latest, money)}.`,
          }
        : largest !== undefined
          ? {
              headline: `${largest.category} is the largest category`,
              detail: `${formatMoney(largest.total, money)} in ${window}.`,
            }
          : {
              headline: `${plural(facts.rows.length, "row was", "rows were")} read`,
              detail: `Every row's amount was summed into the total for ${window}.`,
            };
  return {
    known,
    changed,
    important: {
      statementTypes: ["calculated"],
      ...important,
      evidenceIds: ids,
    },
  };
}

function architecture(
  plan: TablePlan,
  options: CompileOptions,
  pages: readonly Page[],
): DashboardSpec["architecture"] {
  const planNode = options.planner.usesModel
    ? {
        id: "plan",
        kind: "ai" as const,
        label: "Planning model",
        detail: `${options.planner.id} chose column roles and layout from column names and samples.`,
      }
    : {
        id: "plan",
        kind: "process" as const,
        label: "Deterministic planner",
        detail: `${options.planner.id} chose column roles and layout from column names and types.`,
      };
  const nodes = [
    {
      id: "file",
      kind: "input" as const,
      label: options.source.name,
      detail: `${String(options.source.rowCount)} rows uploaded by the reader.`,
    },
    {
      id: "read",
      kind: "process" as const,
      label: "Read columns",
      detail:
        "Cells kept as text; each column profiled by type, distinct values, and samples.",
    },
    planNode,
    {
      id: "compute",
      kind: "process" as const,
      label: "Compute figures",
      detail: `Exact decimal sums, changes, and shares over "${plan.roles.amount}".`,
    },
    ...pages.map((page) => ({
      id: `page-${page.id}`,
      kind: "page" as const,
      label: page.title,
      detail: page.description,
    })),
    {
      id: "output",
      kind: "output" as const,
      label: "Dashboard",
      detail: "Validated against the dashboard contract before rendering.",
    },
  ];
  const edges = [
    { from: "file", to: "read", label: "cells" },
    { from: "read", to: "plan", label: "column profiles" },
    { from: "plan", to: "compute", label: "roles and sections" },
    ...pages.map((page) => ({
      from: "compute",
      to: `page-${page.id}`,
      label: "figures",
    })),
    ...pages.map((page) => ({
      from: `page-${page.id}`,
      to: "output",
      label: "components",
    })),
  ];
  return {
    title: "How this dashboard was built",
    summary:
      "The file is read by trusted code, a planner chooses how to read it, and every figure is computed from the cells with exact arithmetic.",
    nodes,
    edges,
  };
}

function notice(
  plan: TablePlan,
  facts: TableFacts,
  options: CompileOptions,
): string {
  const read = [
    `"${plan.roles.amount}" as the amount`,
    plan.roles.category === undefined
      ? undefined
      : `"${plan.roles.category}" as the category`,
    plan.roles.period === undefined
      ? undefined
      : `"${plan.roles.period}" as the period by ${facts.grain}`,
  ].filter((part) => part !== undefined);
  return `Built from ${options.source.name} (${plural(options.source.rowCount, "row", "rows")}), reading ${read.join(", ")}. ${plural(facts.skipped, "row was", "rows were")} skipped because ${facts.skipped === 1 ? "its" : "their"} amount or period could not be read.`;
}

/** What emptied the table, named so the reader can undo it. */
function emptyReason(plan: TablePlan, facts: TableFacts): string {
  const causes = plan.filters.map(
    (filter) =>
      `${filter.op === "include" ? "keeping only" : "excluding"} ${filter.values
        .map((value) => `"${value}"`)
        .join(", ")} in "${filter.column}"`,
  );
  if (plan.lastPeriods !== undefined && facts.outsideWindow > 0) {
    causes.push(`keeping only the last ${String(plan.lastPeriods)} periods`);
  }
  if (causes.length > 0) {
    return `No rows are left after ${causes.join(" and ")}. Ask for a view that keeps some rows.`;
  }
  return facts.skipped === 0
    ? "The table has no rows to read."
    : `No rows could be read: ${plural(facts.skipped, "row was", "rows were")} skipped because their amount or period could not be read.`;
}

export function compileTablePlan(
  plan: TablePlan,
  table: Table,
  options: CompileOptions,
): DashboardSpec {
  const facts = computeFacts(plan, table);
  if (facts.rows.length === 0) {
    throw new PlanRejected([
      {
        code: "empty_after_filters",
        path: "filters",
        message: emptyReason(plan, facts),
      },
    ]);
  }
  const money = moneyFormat(plan, table, facts);
  const items = evidence(plan, table, facts, options);
  const evidenceIds = items.map((item) => item.id);
  const ctx: SectionContext = { plan, table, facts, money, evidenceIds };

  const pages: Page[] = [];
  for (const page of plan.pages) {
    const components = page.sections
      .map((section) => SECTION_BUILDERS[section](`${page.id}-${section}`, ctx))
      .filter(
        (component): component is DashboardComponent => component !== undefined,
      );
    if (components.length > 0)
      pages.push({
        id: page.id,
        title: page.title,
        description: page.description,
        components,
      });
  }
  if (pages.length === 0) {
    throw new PlanRejected([
      {
        code: "empty_sections",
        path: "pages",
        message:
          "Every section would be empty for this table; the data has too few periods or categories for them.",
      },
    ]);
  }

  return parseDashboardSpec({
    schemaVersion: "1.2",
    id: `table-${options.source.sha256?.slice(0, 16) ?? "upload"}`,
    title: plan.title,
    audience: plan.audience,
    generatedAt: options.asOf,
    dataMode: "live",
    freshness: {
      status: "fresh",
      label: `As of ${options.asOf.slice(0, 10)}`,
      latestObservationAt: options.source.retrievedAt,
    },
    nextAction: {
      title: "Open the evidence",
      detail:
        "Each figure links to the file it came from and the arithmetic that produced it; check those before acting on a number.",
      evidenceIds,
    },
    notice: notice(plan, facts, options),
    pages,
    evidence: items,
    architecture: architecture(plan, options, pages),
    executiveBrief: brief(facts, money, evidenceIds),
  });
}
