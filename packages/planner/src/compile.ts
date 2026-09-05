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
import { abs, compare, periodLabel, sign, type Table } from "./workbook";
import {
  formatMoney,
  formatPercent,
  formatSignedMoney,
  formatSignedPercent,
  isWhole,
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

function comparisonMoneyFormat(
  plan: TablePlan,
  table: Table,
  facts: TableFacts,
): MoneyFormat {
  const currency = table.columns.find(
    (column) => column.name === plan.roles.comparison,
  )?.currency;
  return {
    ...(currency === undefined ? {} : { currency }),
    decimals:
      facts.latestComparison !== undefined && isWhole(facts.latestComparison)
        ? 0
        : 2,
  };
}

function hasActiveRelationship(plan: TablePlan): boolean {
  return plan.pages.some((page) => page.sections.includes("relationship"));
}

function formatRatio(value: string): string {
  return formatMoney(value, { decimals: isWhole(value) ? 0 : 2 });
}

function relationshipUnavailableDetail(
  plan: TablePlan,
  facts: TableFacts,
): string {
  const comparison = plan.roles.comparison ?? "comparison measure";
  switch (facts.relationshipSupport) {
    case "no-prior-period":
      return "There is no prior period in this dataset.";
    case "latest-incomplete":
      return `Not every selected ${plan.roles.amount} row in ${windowLabel(facts)} has a readable ${comparison} value.`;
    case "previous-incomplete":
      return `Not every selected ${plan.roles.amount} row in ${facts.previousPeriod === undefined ? "the prior period" : periodLabel(facts.previousPeriod)} has a readable ${comparison} value.`;
    default:
      if (
        facts.latestComparison !== undefined &&
        sign(facts.latestComparison) === 0
      ) {
        return `The ${comparison} total for ${windowLabel(facts)} is zero.`;
      }
      if (
        facts.previousComparison !== undefined &&
        sign(facts.previousComparison) === 0
      ) {
        return `The ${comparison} total for ${facts.previousPeriod === undefined ? "the prior period" : periodLabel(facts.previousPeriod)} is zero.`;
      }
      if (
        facts.previousTotal !== undefined &&
        sign(facts.previousTotal) === 0
      ) {
        return `The prior ${plan.roles.amount} total is zero, so ratio change is unavailable.`;
      }
      return "The two periods do not have complete comparable support.";
  }
}

/** How the shares on this page were actually produced. */
function sharesSentence(facts: TableFacts): string | undefined {
  if (facts.shares.length === 0) return undefined;
  const omitted = facts.shares.length - RANKING_LIMIT;
  const cut =
    omitted > 0
      ? ` The ranking lists the largest ${String(RANKING_LIMIT)} categories; ${plural(omitted, "more is", "more are")} not shown.`
      : "";
  if (facts.mixedSignFlow !== undefined) {
    return `The latest window has both positive and negative amounts. Gross inflow sums the positive amounts; gross outflow sums the absolute magnitudes of the negative amounts; net movement is their signed sum. Category amounts are grouped by category and direction before inflow shares and outflow shares are independently allocated in tenths of a percent to exactly one hundred; zero is neither direction. Movers are each category's latest signed total minus its previous signed total, ordered by size of change.${cut}`;
  }
  if (facts.shares.some((share) => sign(share.share) < 0)) {
    return `The latest window contains positive and negative amounts, but the plan does not classify them as directional flows. Each category's signed contribution divides its signed total by the signed period total; offsets can produce negative shares or shares above one hundred percent. Movers are each category's latest signed total minus its previous signed total, ordered by size of change.${cut}`;
  }
  const how = facts.sharesSumToHundred
    ? "and are allocated in tenths of a percent so they sum to exactly one hundred"
    : `and every share is reported as zero because the total for ${windowLabel(facts)} is zero`;
  return `Shares divide each category's total by the period total ${how}. Movers are each category's latest total minus its previous total, ordered by size of change.${cut}`;
}

function evidence(
  plan: TablePlan,
  table: Table,
  facts: TableFacts,
  options: CompileOptions,
): Evidence[] {
  const { source } = options;
  const activeRelationship = hasActiveRelationship(plan);
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
    !activeRelationship || plan.roles.comparison === undefined
      ? undefined
      : `The comparison measure was read from "${plan.roles.comparison}" as exact decimals; ${plural(facts.comparisonSkipped, "selected row had", "selected rows had")} no readable comparison value. A relationship period is unavailable unless every selected amount row has a readable comparison value. Both growth rates require complete latest and prior support.${plan.relationship?.operation === "ratio" ? ` ${plan.roles.amount} per ${plan.roles.comparison} is shown only with complete support and non-zero denominators; ratios are rounded half away from zero to two decimals, with whole ratios shown without decimals, and ratio change is computed from unrounded exact cross-products.` : " No denominator or ratio is inferred for this side-by-side comparison."}`,
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
        "A planning model chose the column roles and layout from safe profile metadata; it never saw source values or totals.",
      confidence: "medium",
    });
  }
  return items;
}

function brief(
  plan: TablePlan,
  table: Table,
  facts: TableFacts,
  money: MoneyFormat,
  ids: string[],
): DashboardSpec["executiveBrief"] {
  const window = windowLabel(facts);
  const comparison = plan.roles.comparison;
  if (comparison !== undefined && hasActiveRelationship(plan)) {
    const comparisonMoney = comparisonMoneyFormat(plan, table, facts);
    const comparisonValue =
      facts.latestComparison === undefined
        ? "unavailable"
        : formatMoney(facts.latestComparison, comparisonMoney);
    const known = {
      statementTypes: ["calculated" as const],
      headline: `${formatMoney(facts.latestTotal, money)} ${plan.roles.amount} and ${comparisonValue} ${comparison} for ${window}`,
      detail:
        "Latest amount and complete-support comparison values computed from the dataset.",
      evidenceIds: ids,
    };
    const comparable = facts.relationshipSupport === "complete";
    const changed =
      comparable &&
      facts.previousPeriod !== undefined &&
      facts.changePercent !== undefined &&
      facts.comparisonChangePercent !== undefined
        ? {
            statementTypes: ["calculated" as const],
            headline: `${plan.roles.amount} ${formatSignedPercent(facts.changePercent)}; ${comparison} ${formatSignedPercent(facts.comparisonChangePercent)} vs ${periodLabel(facts.previousPeriod)}`,
            detail:
              "Both growth rates use the same complete latest and prior period support.",
            evidenceIds: ids,
          }
        : {
            statementTypes: ["calculated" as const],
            headline: "The relationship change is unavailable",
            detail: relationshipUnavailableDetail(plan, facts),
            evidenceIds: ids,
          };
    const ratio = facts.relationshipRatio;
    const priorRatio = facts.previousRelationshipRatio;
    const ratioChange = facts.relationshipRatioChangePercent;
    let important: { headline: string; detail: string };
    if (plan.relationship?.operation === "ratio") {
      if (
        ratio === undefined ||
        priorRatio === undefined ||
        ratioChange === undefined
      ) {
        important = {
          headline: `${plan.roles.amount} per ${comparison} is unavailable`,
          detail: relationshipUnavailableDetail(plan, facts),
        };
      } else {
        const movement =
          sign(ratioChange) < 0
            ? `fell from ${formatRatio(priorRatio)} to ${formatRatio(ratio)}`
            : sign(ratioChange) > 0
              ? `rose from ${formatRatio(priorRatio)} to ${formatRatio(ratio)}`
              : `was unchanged at ${formatRatio(ratio)}`;
        const amountVerb =
          facts.changePercent !== undefined && sign(facts.changePercent) > 0
            ? "grew"
            : "changed";
        const comparisonVerb =
          facts.comparisonChangePercent !== undefined &&
          sign(facts.comparisonChangePercent) > 0
            ? "grew"
            : "changed";
        important = {
          headline: `${plan.roles.amount} per ${comparison} ${movement} (${formatSignedPercent(ratioChange)})`,
          detail:
            facts.changePercent === undefined ||
            facts.comparisonChangePercent === undefined
              ? "The ratio uses complete latest and prior period support."
              : `${comparison} ${comparisonVerb} ${formatSignedPercent(facts.comparisonChangePercent)} while ${plan.roles.amount} ${amountVerb} ${formatSignedPercent(facts.changePercent)}.`,
        };
      }
    } else if (
      comparable &&
      facts.changePercent !== undefined &&
      facts.comparisonChangePercent !== undefined
    ) {
      const relative = compare(
        facts.comparisonChangePercent,
        facts.changePercent,
      );
      important = {
        headline:
          relative === 0
            ? `${plan.roles.amount} and ${comparison} changed at the same rate`
            : `${relative > 0 ? comparison : plan.roles.amount} changed more than ${relative > 0 ? plan.roles.amount : comparison}`,
        detail: `${plan.roles.amount} changed ${formatSignedPercent(facts.changePercent)} and ${comparison} changed ${formatSignedPercent(facts.comparisonChangePercent)}.`,
      };
    } else {
      important = {
        headline: `${plan.roles.amount} vs ${comparison} is unavailable`,
        detail: relationshipUnavailableDetail(plan, facts),
      };
    }
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

  if (facts.mixedSignFlow !== undefined) {
    const flow = facts.mixedSignFlow;
    const largestOutflow = facts.shares.find(
      (share) => share.direction === "outflow",
    );
    const importantHeadline =
      sign(flow.netMovement) > 0
        ? `Inflows exceeded outflows by ${formatMoney(flow.netMovement, money)}`
        : sign(flow.netMovement) < 0
          ? `Outflows exceeded inflows by ${formatMoney(abs(flow.netMovement), money)}`
          : "Inflows and outflows offset exactly";
    return {
      known: {
        statementTypes: ["calculated"],
        headline: `${formatMoney(flow.grossInflow, money)} gross inflow versus ${formatMoney(flow.grossOutflow, money)} gross outflow for ${window}`,
        detail:
          "Positive and negative amounts were summed separately with exact decimals.",
        evidenceIds: ids,
      },
      changed: {
        statementTypes: ["calculated"],
        headline: "The latest window contains both inflows and outflows",
        detail:
          "At least one selected amount is positive and at least one is negative; zero counts as neither direction.",
        evidenceIds: ids,
      },
      important: {
        statementTypes: ["calculated"],
        headline: importantHeadline,
        detail:
          largestOutflow === undefined
            ? "The signed difference between gross inflow and gross outflow is the net movement."
            : `${largestOutflow.category} is the largest outflow driver at ${formatPercent(largestOutflow.share)} of outflows.`,
        evidenceIds: ids,
      },
    };
  }

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

function relationshipNextAction(
  plan: TablePlan,
  facts: TableFacts,
  evidenceIds: string[],
): DashboardSpec["nextAction"] | undefined {
  const comparison = plan.roles.comparison;
  if (comparison === undefined || !hasActiveRelationship(plan))
    return undefined;
  const window = windowLabel(facts);
  if (facts.relationshipSupport !== "complete") {
    return {
      title: `Check the ${plan.roles.amount}–${comparison} support`,
      detail: `${relationshipUnavailableDetail(plan, facts)} Confirm the source observations before comparing the measures.`,
      evidenceIds,
    };
  }
  const ratio = facts.relationshipRatio;
  const priorRatio = facts.previousRelationshipRatio;
  const ratioChange = facts.relationshipRatioChangePercent;
  if (
    plan.relationship?.operation === "ratio" &&
    ratio !== undefined &&
    priorRatio !== undefined &&
    ratioChange !== undefined &&
    facts.previousPeriod !== undefined
  ) {
    const movement =
      sign(ratioChange) < 0
        ? { noun: "drop", verb: "fell" }
        : sign(ratioChange) > 0
          ? { noun: "increase", verb: "rose" }
          : { noun: "stability", verb: "held" };
    return {
      title: `Review the ${movement.noun} in ${plan.roles.amount} per ${comparison}`,
      detail: `${plan.roles.amount} per ${comparison} ${movement.verb} from ${formatRatio(priorRatio)} in ${periodLabel(facts.previousPeriod)} to ${formatRatio(ratio)} in ${window} (${formatSignedPercent(ratioChange)}), while ${comparison} changed ${formatSignedPercent(facts.comparisonChangePercent as string)} and ${plan.roles.amount} changed ${formatSignedPercent(facts.changePercent as string)}. Check the linked observations and operating context before acting; this comparison does not establish a cause.`,
      evidenceIds,
    };
  }
  if (plan.relationship?.operation === "ratio" && ratio === undefined) {
    return {
      title: `Check the ${plan.roles.amount}-per-${comparison} inputs`,
      detail: `${relationshipUnavailableDetail(plan, facts)} Confirm the source observation before using the ratio.`,
      evidenceIds,
    };
  }
  if (
    facts.previousPeriod !== undefined &&
    facts.changePercent !== undefined &&
    facts.comparisonChangePercent !== undefined
  ) {
    const relative = compare(
      facts.comparisonChangePercent,
      facts.changePercent,
    );
    if (relative === 0) {
      return {
        title: `Review why ${plan.roles.amount} and ${comparison} moved together`,
        detail: `From ${periodLabel(facts.previousPeriod)} to ${window}, both measures changed ${formatSignedPercent(facts.changePercent)}. Check the linked observations and operating context before acting; this comparison does not establish a cause.`,
        evidenceIds,
      };
    }
    const higher = relative > 0 ? comparison : plan.roles.amount;
    const lower = relative > 0 ? plan.roles.amount : comparison;
    const higherGrowth =
      relative > 0 ? facts.comparisonChangePercent : facts.changePercent;
    const lowerGrowth =
      relative > 0 ? facts.changePercent : facts.comparisonChangePercent;
    const bothGrew = sign(higherGrowth) >= 0 && sign(lowerGrowth) >= 0;
    return {
      title: `Review why ${higher} ${bothGrew ? "grew faster" : "changed more"} than ${lower}`,
      detail: `From ${periodLabel(facts.previousPeriod)} to ${window}, ${higher} changed ${formatSignedPercent(higherGrowth)} while ${lower} changed ${formatSignedPercent(lowerGrowth)}. Check the linked observations and operating context before acting; this comparison does not establish a cause.`,
      evidenceIds,
    };
  }
  return {
    title: `Review the latest ${plan.roles.amount}–${comparison} comparison`,
    detail: `Both prior-period growth rates are not available. Check the linked observations before acting; this comparison does not establish a cause.`,
    evidenceIds,
  };
}

function mixedSignNextAction(
  facts: TableFacts,
  money: MoneyFormat,
  evidenceIds: string[],
): DashboardSpec["nextAction"] | undefined {
  if (facts.mixedSignFlow === undefined) return undefined;
  const largestOutflow = facts.shares.find(
    (share) => share.direction === "outflow",
  );
  if (largestOutflow === undefined) return undefined;
  return {
    title: `Review ${largestOutflow.category}, the largest outflow driver`,
    detail: `${largestOutflow.category} accounts for ${formatPercent(largestOutflow.share)} of outflows (${formatMoney(abs(largestOutflow.total), money)}) for ${windowLabel(facts)}. Review the linked rows to understand what contributes to this category before deciding whether follow-up is needed.`,
    evidenceIds,
  };
}

function architecture(
  plan: TablePlan,
  facts: TableFacts,
  options: CompileOptions,
  pages: readonly Page[],
): DashboardSpec["architecture"] {
  const activeRelationship = hasActiveRelationship(plan);
  const planNode = options.planner.usesModel
    ? {
        id: "plan",
        kind: "ai" as const,
        label: "Planning model",
        detail: `${options.planner.id} chose column roles and layout from safe column metadata without source values.`,
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
      detail:
        !activeRelationship || plan.roles.comparison === undefined
          ? facts.mixedSignFlow === undefined
            ? `Exact decimal sums, changes, and shares over "${plan.roles.amount}".`
            : `Exact decimal gross inflow, gross outflow, net movement, and direction-aware shares over "${plan.roles.amount}".`
          : `Exact decimal sums and changes over "${plan.roles.amount}" and "${plan.roles.comparison}"${plan.relationship?.operation === "ratio" ? ", plus their complete-support ratio and ratio change" : ", without inferring a denominator"}.`,
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
  const activeRelationship = hasActiveRelationship(plan);
  const read = [
    `"${plan.roles.amount}" as the amount`,
    !activeRelationship || plan.roles.comparison === undefined
      ? undefined
      : `"${plan.roles.comparison}" as the comparison measure`,
    plan.roles.category === undefined
      ? undefined
      : `"${plan.roles.category}" as the category`,
    plan.roles.period === undefined
      ? undefined
      : `"${plan.roles.period}" as the period by ${facts.grain}`,
  ].filter((part) => part !== undefined);
  return `Built from ${options.source.name} (${plural(options.source.rowCount, "row", "rows")}), reading ${read.join(", ")}. ${plural(facts.skipped, "row was", "rows were")} skipped because ${facts.skipped === 1 ? "its" : "their"} amount or period could not be read.`;
}

/** What actually emptied the table, named so the reader can undo it. */
function emptyReason(plan: TablePlan, facts: TableFacts): string {
  const removals: string[] = [];
  if (facts.filteredOut > 0) {
    removals.push(
      ...plan.filters.map(
        (filter) =>
          `${filter.op === "include" ? "keeping only" : "excluding"} ${filter.values
            .map((value) => `"${value}"`)
            .join(", ")} in "${filter.column}"`,
      ),
    );
  }
  if (plan.lastPeriods !== undefined && facts.outsideWindow > 0) {
    removals.push(`keeping only the last ${String(plan.lastPeriods)} periods`);
  }
  const alsoSkipped =
    facts.skipped === 0
      ? ""
      : `, with ${plural(facts.skipped, "row", "rows")} skipped because their amount or period could not be read`;
  if (removals.length > 0) {
    return `No rows are left after ${removals.join(" and ")}${alsoSkipped}. Ask for a view that keeps some rows.`;
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

  const action = relationshipNextAction(plan, facts, evidenceIds) ??
    mixedSignNextAction(facts, money, evidenceIds) ?? {
      title: "Open the evidence",
      detail:
        "Each figure links to the file it came from and the arithmetic that produced it; check those before acting on a number.",
      evidenceIds,
    };

  return parseDashboardSpec({
    schemaVersion: "1.2",
    id: `table-${options.source.sha256?.slice(0, 16) ?? "upload"}`,
    title: plan.title,
    audience: plan.audience,
    generatedAt: options.asOf,
    dataMode: "live",
    freshness: {
      // An upload is a bounded snapshot. Its latest period is known, but the
      // file does not prove that period is complete or still current.
      status: "partial",
      label:
        facts.latestPeriod === undefined
          ? `Built ${options.asOf.slice(0, 10)}`
          : `Data through ${periodLabel(facts.latestPeriod)}`,
    },
    nextAction: action,
    notice: notice(plan, facts, options),
    pages,
    evidence: items,
    architecture: architecture(plan, facts, options, pages),
    executiveBrief: brief(plan, table, facts, money, evidenceIds),
  });
}
