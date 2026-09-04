/**
 * One component per plan section, built from computed facts. A builder returns
 * undefined when its section would have nothing to show.
 */
import type { DashboardComponent } from "@dasher/dashboard-schema";
import {
  compare,
  periodLabel,
  periodStartIso,
  round,
  sign,
  type Exact,
  type Table,
} from "./workbook";
import {
  formatMoney,
  formatPercent,
  formatSignedMoney,
  formatSignedPercent,
  plural,
  type MoneyFormat,
} from "./arith";
import { largestCategories, type FactRow, type TableFacts } from "./facts";
import type { TablePlan, TableSectionKind } from "./table-plan";

type Alert = Extract<
  DashboardComponent,
  { kind: "alert-list" }
>["alerts"][number];

export interface SectionContext {
  readonly plan: TablePlan;
  readonly table: Table;
  readonly facts: TableFacts;
  readonly money: MoneyFormat;
  readonly evidenceIds: readonly string[];
}

/** How many entries a ranking shows; the rest are counted, never dropped silently. */
export const RANKING_LIMIT = 100;

export const EVIDENCE = {
  source: "source-file",
  calculations: "calculations",
  composition: "composition",
} as const;

function direction(
  value: Exact | undefined,
): "up" | "down" | "steady" | "unknown" {
  if (value === undefined) return "unknown";
  const s = sign(value);
  return s > 0 ? "up" : s < 0 ? "down" : "steady";
}

/** RULE: a truncated ranking says what it left out. */
export function rankingTitle(title: string, shown: number, total: number): string {
  return total > shown
    ? `${title} (largest ${String(shown)} of ${String(total)})`
    : title;
}

export function windowLabel(facts: TableFacts): string {
  return facts.latestPeriod === undefined
    ? "the whole file"
    : periodLabel(facts.latestPeriod);
}

function changeText(facts: TableFacts, money: MoneyFormat): string | undefined {
  if (facts.change === undefined || facts.previousPeriod === undefined)
    return undefined;
  const pct =
    facts.changePercent === undefined
      ? ""
      : ` (${formatSignedPercent(facts.changePercent)})`;
  return `${formatSignedMoney(facts.change, money)}${pct} vs ${periodLabel(facts.previousPeriod)}`;
}

/** The rows behind every figure labelled with the window: the latest period's. */
function windowRows(facts: TableFacts): number {
  return facts.rows.filter(
    (row) => facts.latestPeriod === undefined || row.period === facts.latestPeriod,
  ).length;
}

function rowLabel(row: FactRow): string {
  const label = row.label?.trim();
  if (label !== undefined && label !== "") return label;
  if (row.category !== undefined) return row.category;
  return `Row ${String(row.index + 1)}`;
}

function summary(id: string, ctx: SectionContext): DashboardComponent {
  const { facts, money, evidenceIds } = ctx;
  const window = windowLabel(facts);
  const claims: { text: string; evidenceIds: string[] }[] = [
    {
      text: `Total for ${window} is ${formatMoney(facts.latestTotal, money)} across ${plural(windowRows(facts), "row", "rows")}.`,
      evidenceIds: [...evidenceIds],
    },
  ];
  const change = changeText(facts, money);
  claims.push({
    text:
      change === undefined
        ? "There is no earlier period in this file to compare with."
        : `Change: ${change}.`,
    evidenceIds: [...evidenceIds],
  });
  const largest = facts.shares[0];
  if (largest !== undefined) {
    claims.push({
      text: `${largest.category} is the largest category at ${formatMoney(largest.total, money)}, ${formatPercent(largest.share)} of ${window}.`,
      evidenceIds: [...evidenceIds],
    });
  }
  const over = facts.budget.filter((line) => line.over);
  if (facts.budget.length > 0) {
    claims.push({
      text:
        over.length === 0
          ? "Every budgeted line is within budget."
          : `${String(over.length)} of ${plural(facts.budget.length, "budgeted line", "budgeted lines")} ${over.length === 1 ? "is" : "are"} over budget.`,
      evidenceIds: [...evidenceIds],
    });
  }
  return {
    id,
    kind: "summary",
    title: "Summary",
    subtitle: ctx.plan.framing,
    evidenceIds: [...evidenceIds],
    claims,
    tone: over.length > 0 ? "attention" : "normal",
  };
}

function headlineTotals(id: string, ctx: SectionContext): DashboardComponent {
  const { facts, money, evidenceIds } = ctx;
  const ids = [...evidenceIds];
  const metrics: Extract<
    DashboardComponent,
    { kind: "metric-grid" }
  >["metrics"] = [
    {
      label: `Total, ${windowLabel(facts)}`,
      value: formatMoney(facts.latestTotal, money),
      evidenceIds: ids,
    },
  ];
  const change = changeText(facts, money);
  if (facts.change !== undefined) {
    metrics.push({
      label: "Change vs prior period",
      value: formatSignedMoney(facts.change, money),
      ...(change === undefined ? {} : { change }),
      direction: direction(facts.change),
      evidenceIds: ids,
    });
  }
  // RULE: a count is labelled with the window it counts, so it cannot read as a
  // contradiction of the total beside it.
  metrics.push({
    label: `Rows counted, ${windowLabel(facts)}`,
    value: String(windowRows(facts)),
    evidenceIds: ids,
  });
  if (facts.categories.length > 0) {
    metrics.push({
      label: "Categories",
      value: String(facts.categories.length),
      evidenceIds: ids,
    });
  }
  const largest = facts.shares[0];
  if (largest !== undefined) {
    metrics.push({
      label: "Largest category",
      value: largest.category,
      change: formatPercent(largest.share),
      evidenceIds: ids,
    });
  }
  return {
    id,
    kind: "metric-grid",
    title: "Headline totals",
    evidenceIds: ids,
    metrics,
  };
}

function byCategory(
  id: string,
  ctx: SectionContext,
): DashboardComponent | undefined {
  const { facts, money, evidenceIds } = ctx;
  if (facts.shares.length === 0) return undefined;
  return {
    id,
    kind: "ranking",
    title: rankingTitle(
      `By category, ${windowLabel(facts)}`,
      RANKING_LIMIT,
      facts.shares.length,
    ),
    evidenceIds: [...evidenceIds],
    items: facts.shares.slice(0, RANKING_LIMIT).map((share, index) => ({
      id: `${id}-${String(index + 1)}`,
      label: share.category,
      value: formatMoney(share.total, money),
      note: `${formatPercent(share.share)} of the total`,
      evidenceIds: [...evidenceIds],
    })),
  };
}

function movers(
  id: string,
  ctx: SectionContext,
): DashboardComponent | undefined {
  const { facts, money, evidenceIds } = ctx;
  if (
    facts.movers.length === 0 ||
    facts.previousPeriod === undefined ||
    facts.latestPeriod === undefined
  )
    return undefined;
  return {
    id,
    kind: "ranking",
    title: rankingTitle(
      `Movers, ${periodLabel(facts.previousPeriod)} to ${periodLabel(facts.latestPeriod)}`,
      RANKING_LIMIT,
      facts.movers.length,
    ),
    evidenceIds: [...evidenceIds],
    items: facts.movers.slice(0, RANKING_LIMIT).map((mover, index) => ({
      id: `${id}-${String(index + 1)}`,
      label: mover.category,
      value: formatSignedMoney(mover.change, money),
      note: `${formatMoney(mover.previous, money)} to ${formatMoney(mover.latest, money)}${mover.changePercent === undefined ? "" : ` (${formatSignedPercent(mover.changePercent)})`}`,
      evidenceIds: [...evidenceIds],
    })),
  };
}

function trend(
  id: string,
  ctx: SectionContext,
): DashboardComponent | undefined {
  const { facts, money, evidenceIds } = ctx;
  if (facts.periods.length < 2) return undefined;
  const unit = money.currency ?? "amount";
  // RULE: a chart point carries the same figure the page prints, rounded to the
  // money scale before it becomes a JavaScript number.
  const points = (
    value: (period: string) => Exact,
  ): { at: string; value: number }[] =>
    facts.periods.map((period) => ({
      at: periodStartIso(period),
      value: Number(round(value(period), money.decimals)),
    }));
  const series = [
    {
      id: `${id}-total`,
      label: "Total",
      unit,
      evidenceIds: [...evidenceIds],
      points: points((period) => facts.totalsByPeriod.get(period) ?? "0"),
    },
    ...largestCategories(facts, 5).map((category, index) => ({
      id: `${id}-${String(index + 1)}`,
      label: category,
      unit,
      evidenceIds: [...evidenceIds],
      points: points(
        (period) =>
          facts.categoryTotalsByPeriod.get(period)?.get(category) ?? "0",
      ),
    })),
  ];
  return {
    id,
    kind: "trend-list",
    title: `Trend by ${facts.grain}`,
    evidenceIds: [...evidenceIds],
    series,
  };
}

function largestRows(
  id: string,
  ctx: SectionContext,
): DashboardComponent | undefined {
  const { facts, money, evidenceIds } = ctx;
  if (facts.largestRows.length === 0) return undefined;
  return {
    id,
    kind: "ranking",
    title: "Largest rows",
    evidenceIds: [...evidenceIds],
    items: facts.largestRows.map((row) => ({
      id: `${id}-row-${String(row.index + 1)}`,
      label: rowLabel(row).slice(0, 256),
      value: formatMoney(row.amount, money),
      note:
        [
          row.category,
          row.period === undefined ? undefined : periodLabel(row.period),
        ]
          .filter((part) => part !== undefined)
          .join(" · ") || `Row ${String(row.index + 1)}`,
      evidenceIds: [...evidenceIds],
    })),
  };
}

function budgetVariance(
  id: string,
  ctx: SectionContext,
): DashboardComponent | undefined {
  const { facts, money, evidenceIds } = ctx;
  if (facts.budget.length === 0) return undefined;
  const over = facts.budget.filter((line) => line.over);
  const alerts: Alert[] = over.slice(0, 200).map((line, index) => ({
    id: `${id}-${String(index + 1)}`,
    severity:
      line.variancePercent !== undefined &&
      compare(line.variancePercent, "10") > 0
        ? "warning"
        : "attention",
    title: `${line.name} over budget by ${formatMoney(line.variance, money)}`,
    detail: `${formatMoney(line.amount, money)} against a budget of ${formatMoney(line.budget, money)} for ${windowLabel(facts)}${line.variancePercent === undefined ? "" : ` (${formatSignedPercent(line.variancePercent)})`}.`,
    evidenceIds: [...evidenceIds],
  }));
  if (alerts.length === 0) {
    alerts.push({
      id: `${id}-within`,
      severity: "info",
      title: "All lines within budget",
      detail: `Every budgeted line spent at or under its budget for ${windowLabel(facts)}.`,
      evidenceIds: [...evidenceIds],
    });
  }
  return {
    id,
    kind: "alert-list",
    title: "Budget variance",
    evidenceIds: [...evidenceIds],
    alerts,
  };
}

function tableComponent(
  id: string,
  ctx: SectionContext,
): DashboardComponent | undefined {
  const { plan, table, facts, evidenceIds } = ctx;
  if (facts.rows.length === 0) return undefined;
  const roleNames = [
    plan.roles.period,
    plan.roles.label,
    plan.roles.category,
    plan.roles.account,
    plan.roles.amount,
    plan.roles.budget,
  ].filter((name): name is string => name !== undefined);
  const others = table.columns
    .map((column) => column.name)
    .filter((name) => !roleNames.includes(name))
    .slice(0, 6);
  const names = [...new Set([...roleNames, ...others])].slice(0, 12);
  const indexes = names.map(
    (name) => table.columns.find((column) => column.name === name)?.index ?? 0,
  );
  return {
    id,
    kind: "table",
    title: "Rows",
    evidenceIds: [...evidenceIds],
    columns: names,
    rows: facts.rows.slice(0, 50).map((row) => ({
      id: `${id}-row-${String(row.index + 1)}`,
      cells: indexes.map((index) => (row.cells[index] ?? "").slice(0, 256)),
      evidenceIds: [...evidenceIds],
    })),
  };
}

export const SECTION_BUILDERS: Readonly<
  Record<
    TableSectionKind,
    (id: string, ctx: SectionContext) => DashboardComponent | undefined
  >
> = {
  summary,
  "headline-totals": headlineTotals,
  "by-category": byCategory,
  movers,
  trend,
  "largest-rows": largestRows,
  "budget-variance": budgetVariance,
  table: tableComponent,
};
