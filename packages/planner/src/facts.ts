/**
 * Every figure the dashboard shows, computed once from the table with exact
 * decimals. Nothing here formats; nothing here decides layout.
 */
import {
  abs,
  add,
  bucketPeriod,
  compare,
  comparePeriods,
  parseAmount,
  parseDate,
  parsePeriodHeader,
  periodGrain,
  periodStartIso,
  sign,
  subtract,
  ZERO,
  type ColumnProfile,
  type Exact,
  type Grain,
  type Table,
} from "./workbook";
import { allocatePercents, compareAbsDesc, isWhole, percentOf } from "./arith";
import type { TablePlan } from "./table-plan";

export interface FactRow {
  /** Zero-based position in the table's rows. */
  readonly index: number;
  readonly cells: readonly string[];
  readonly amount: Exact;
  readonly budget?: Exact;
  readonly category?: string;
  readonly label?: string;
  readonly period?: string;
}

export interface CategoryShare {
  readonly category: string;
  readonly total: Exact;
  readonly share: Exact;
}

export interface Mover {
  readonly category: string;
  readonly latest: Exact;
  readonly previous: Exact;
  readonly change: Exact;
  readonly changePercent?: Exact;
}

export interface BudgetLine {
  readonly name: string;
  readonly amount: Exact;
  readonly budget: Exact;
  readonly variance: Exact;
  readonly variancePercent?: Exact;
  readonly over: boolean;
}

export interface TableFacts {
  readonly rows: readonly FactRow[];
  readonly skipped: number;
  /** Rows the plan's own filters removed. */
  readonly filteredOut: number;
  /** Rows dropped because they fall outside the plan's period window. */
  readonly outsideWindow: number;
  /** The grain the buckets actually use, never finer than the period column. */
  readonly grain: Grain;
  readonly periods: readonly string[];
  readonly latestPeriod?: string;
  readonly previousPeriod?: string;
  readonly totalsByPeriod: ReadonlyMap<string, Exact>;
  readonly categoryTotalsByPeriod: ReadonlyMap<
    string,
    ReadonlyMap<string, Exact>
  >;
  /** Total for the latest period, or for every row when there is no period. */
  readonly latestTotal: Exact;
  readonly previousTotal?: Exact;
  readonly change?: Exact;
  readonly changePercent?: Exact;
  readonly shares: readonly CategoryShare[];
  /** True when the shares were allocated so they add up to exactly 100. */
  readonly sharesSumToHundred: boolean;
  readonly movers: readonly Mover[];
  readonly largestRows: readonly FactRow[];
  readonly budget: readonly BudgetLine[];
  readonly categories: readonly string[];
  readonly wholeAmounts: boolean;
}

const GRAIN_RANK: Readonly<Record<Grain, number>> = {
  month: 2,
  quarter: 1,
  year: 0,
};

function columnOf(
  table: Table,
  name: string | undefined,
): ColumnProfile | undefined {
  if (name === undefined) return undefined;
  return table.columns.find((one) => one.name === name);
}

function columnIndex(
  table: Table,
  name: string | undefined,
): number | undefined {
  return columnOf(table, name)?.index;
}

const BLANK = "(blank)";

/** RULE: a blank category is shown, and so filtered, as "(blank)". */
function categoryValue(cell: string | undefined): string {
  return cell === undefined || cell.trim() === "" ? BLANK : cell;
}

/**
 * RULE: a cell is re-read under the convention its own column was profiled
 * with, so `1.250` and `01/02/2026` mean here what they mean in the file.
 */
function cellPeriod(
  text: string,
  column: ColumnProfile | undefined,
  grain: Grain,
): string | undefined {
  if (column?.type === "date") {
    const date = parseDate(text, { dates: column.dates });
    return date === null ? undefined : bucketPeriod(date.iso, grain);
  }
  const header = parsePeriodHeader(text);
  if (header === null) return undefined;
  return GRAIN_RANK[periodGrain(header.key)] > GRAIN_RANK[grain]
    ? bucketPeriod(periodStartIso(header.key), grain)
    : header.key;
}

/** RULE: a filter compares against the value the dashboard shows for the cell. */
function passesFilters(
  cells: readonly string[],
  plan: TablePlan,
  table: Table,
  categoryAt: number | undefined,
): boolean {
  return plan.filters.every((filter) => {
    const index = columnIndex(table, filter.column);
    if (index === undefined) return true;
    const shown =
      index === categoryAt ? categoryValue(cells[index]) : (cells[index] ?? "");
    const cell = shown.toLowerCase();
    const matches = filter.values.some((value) => value.toLowerCase() === cell);
    return filter.op === "include" ? matches : !matches;
  });
}

/**
 * RULE: buckets are never finer than the period column itself, so a quarterly
 * column is read by quarter however the plan asked for it.
 */
export function planGrain(plan: TablePlan, table: Table): Grain {
  const periodAt = columnIndex(table, plan.roles.period);
  if (periodAt === undefined) return plan.grain;
  if (table.columns[periodAt]?.type === "date") return plan.grain;
  const categoryAt = columnIndex(table, plan.roles.category);
  let grain = plan.grain;
  for (const cells of table.rows) {
    if (!passesFilters(cells, plan, table, categoryAt)) continue;
    const header = parsePeriodHeader(cells[periodAt] ?? "");
    if (header === null) continue;
    const own = periodGrain(header.key);
    if (GRAIN_RANK[own] < GRAIN_RANK[grain]) grain = own;
  }
  return grain;
}

function sumBy<T>(
  items: readonly T[],
  key: (item: T) => string,
  value: (item: T) => Exact,
): Map<string, Exact> {
  const totals = new Map<string, Exact>();
  for (const item of items) {
    const k = key(item);
    totals.set(k, add(totals.get(k) ?? ZERO, value(item)));
  }
  return totals;
}

/** RULE: "largest" means largest in size, so a negative total ranks by magnitude. */
function sortedAbsDesc(totals: ReadonlyMap<string, Exact>): [string, Exact][] {
  return [...totals.entries()].sort(
    (a, b) => compareAbsDesc(a[1], b[1]) || a[0].localeCompare(b[0]),
  );
}

/** Reads the rows a plan selects and computes every figure from them. */
export function computeFacts(plan: TablePlan, table: Table): TableFacts {
  const amountColumn = columnOf(table, plan.roles.amount);
  const budgetColumn = columnOf(table, plan.roles.budget);
  const periodColumn = columnOf(table, plan.roles.period);
  const amountAt = amountColumn?.index;
  const budgetAt = budgetColumn?.index;
  const categoryAt = columnIndex(table, plan.roles.category);
  const labelAt = columnIndex(table, plan.roles.label);
  const periodAt = periodColumn?.index;
  if (amountAt === undefined)
    throw new Error(`Column "${plan.roles.amount}" is not in the table`);

  const grain = planGrain(plan, table);
  let skipped = 0;
  let filteredOut = 0;
  let outsideWindow = 0;
  let rows: FactRow[] = [];
  for (const [index, cells] of table.rows.entries()) {
    if (!passesFilters(cells, plan, table, categoryAt)) {
      filteredOut += 1;
      continue;
    }
    const amount = parseAmount(cells[amountAt] ?? "", {
      decimal: amountColumn?.decimal,
    });
    if (amount === null) {
      skipped += 1;
      continue;
    }
    const budgetText =
      budgetAt === undefined
        ? null
        : parseAmount(cells[budgetAt] ?? "", {
            decimal: budgetColumn?.decimal,
          });
    const period =
      periodAt === undefined
        ? undefined
        : cellPeriod(cells[periodAt] ?? "", periodColumn, grain);
    if (periodAt !== undefined && period === undefined) {
      skipped += 1;
      continue;
    }
    rows.push({
      index,
      cells,
      amount,
      ...(budgetText === null ? {} : { budget: budgetText }),
      ...(categoryAt === undefined
        ? {}
        : { category: categoryValue(cells[categoryAt]) }),
      ...(labelAt === undefined ? {} : { label: cells[labelAt] ?? "" }),
      ...(period === undefined ? {} : { period }),
    });
  }

  let periods = [
    ...new Set(
      rows.flatMap((row) => (row.period === undefined ? [] : [row.period])),
    ),
  ].sort(comparePeriods);
  if (plan.lastPeriods !== undefined && periods.length > plan.lastPeriods) {
    const kept = new Set(periods.slice(-plan.lastPeriods));
    const before = rows.length;
    rows = rows.filter(
      (row) => row.period !== undefined && kept.has(row.period),
    );
    outsideWindow += before - rows.length;
    periods = periods.filter((period) => kept.has(period));
  }

  const latestPeriod = periods.at(-1);
  const previousPeriod = periods.length >= 2 ? periods.at(-2) : undefined;
  const totalsByPeriod = sumBy(
    rows.filter((row) => row.period !== undefined),
    (row) => row.period as string,
    (row) => row.amount,
  );
  const categoryTotalsByPeriod = new Map<string, Map<string, Exact>>();
  for (const period of periods) {
    categoryTotalsByPeriod.set(
      period,
      sumBy(
        rows.filter(
          (row) => row.period === period && row.category !== undefined,
        ),
        (row) => row.category as string,
        (row) => row.amount,
      ),
    );
  }

  const latestRows =
    latestPeriod === undefined
      ? rows
      : rows.filter((row) => row.period === latestPeriod);
  const latestTotal = latestRows.reduce(
    (sum, row) => add(sum, row.amount),
    ZERO,
  );
  const previousTotal =
    previousPeriod === undefined
      ? undefined
      : totalsByPeriod.get(previousPeriod);
  const change =
    previousTotal === undefined
      ? undefined
      : subtract(latestTotal, previousTotal);
  const changePercent =
    change === undefined || previousTotal === undefined
      ? undefined
      : percentOf(change, previousTotal);

  const latestByCategory = sortedAbsDesc(
    sumBy(
      latestRows.filter((row) => row.category !== undefined),
      (row) => row.category as string,
      (row) => row.amount,
    ),
  );
  const shareValues = allocatePercents(
    latestByCategory.map(([, total]) => total),
  );
  const shares: CategoryShare[] = latestByCategory.map(
    ([category, total], index) => ({
      category,
      total,
      share: shareValues[index] as Exact,
    }),
  );
  // The allocation only holds when every part is positive; otherwise each share
  // is rounded on its own and the sentence about them has to say so.
  const sharesSumToHundred =
    shares.length > 0 &&
    latestByCategory.every(([, total]) => sign(total) >= 0) &&
    compare(
      shares.reduce((sum, share) => add(sum, share.share), ZERO),
      "100",
    ) === 0;

  const movers: Mover[] = [];
  if (latestPeriod !== undefined && previousPeriod !== undefined) {
    const latest =
      categoryTotalsByPeriod.get(latestPeriod) ?? new Map<string, Exact>();
    const previous =
      categoryTotalsByPeriod.get(previousPeriod) ?? new Map<string, Exact>();
    for (const category of new Set([...latest.keys(), ...previous.keys()])) {
      const now = latest.get(category) ?? ZERO;
      const then = previous.get(category) ?? ZERO;
      const delta = subtract(now, then);
      const pct = percentOf(delta, then);
      movers.push({
        category,
        latest: now,
        previous: then,
        change: delta,
        ...(pct === undefined ? {} : { changePercent: pct }),
      });
    }
    movers.sort(
      (a, b) =>
        compareAbsDesc(a.change, b.change) ||
        a.category.localeCompare(b.category),
    );
  }

  const largestRows = [...rows]
    .sort((a, b) => compareAbsDesc(a.amount, b.amount) || a.index - b.index)
    .slice(0, 10);

  const budget: BudgetLine[] = [];
  if (budgetAt !== undefined) {
    const nameOf = (row: FactRow): string =>
      row.category ?? row.label ?? "All rows";
    // RULE: a line is spent by every row it has in the period, budgeted by the
    // budget cells it states; a row without a budget cell still spends.
    const amounts = sumBy(latestRows, nameOf, (row) => row.amount);
    const budgets = sumBy(
      latestRows.filter((row) => row.budget !== undefined),
      nameOf,
      (row) => row.budget as Exact,
    );
    for (const [name, allowed] of budgets) {
      const amount = amounts.get(name) ?? ZERO;
      const variance = subtract(amount, allowed);
      const pct = percentOf(variance, allowed);
      budget.push({
        name,
        amount,
        budget: allowed,
        variance,
        ...(pct === undefined ? {} : { variancePercent: pct }),
        over: sign(variance) > 0,
      });
    }
    budget.sort(
      (a, b) => compare(b.variance, a.variance) || a.name.localeCompare(b.name),
    );
  }

  return {
    rows,
    skipped,
    filteredOut,
    outsideWindow,
    grain,
    periods,
    ...(latestPeriod === undefined ? {} : { latestPeriod }),
    ...(previousPeriod === undefined ? {} : { previousPeriod }),
    totalsByPeriod,
    categoryTotalsByPeriod,
    latestTotal,
    ...(previousTotal === undefined ? {} : { previousTotal }),
    ...(change === undefined ? {} : { change }),
    ...(changePercent === undefined ? {} : { changePercent }),
    shares,
    sharesSumToHundred,
    movers,
    largestRows,
    budget,
    categories: [
      ...new Set(
        rows.flatMap((row) =>
          row.category === undefined ? [] : [row.category],
        ),
      ),
    ].sort(),
    wholeAmounts: rows.every(
      (row) =>
        isWhole(row.amount) &&
        (row.budget === undefined || isWhole(row.budget)),
    ),
  };
}

/** The five largest categories over the whole window, for trend series. */
export function largestCategories(facts: TableFacts, limit: number): string[] {
  const totals = sumBy(
    facts.rows.filter((row) => row.category !== undefined),
    (row) => row.category as string,
    (row) => abs(row.amount),
  );
  return sortedAbsDesc(totals)
    .slice(0, limit)
    .map(([category]) => category);
}
