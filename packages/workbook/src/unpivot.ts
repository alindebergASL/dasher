/**
 * Turning a wide file, one column per period, into one row per (line, period).
 */

import { profileColumn, type ProfileOptions } from "./infer";
import { parsePeriodHeader } from "./parse-values";
import type { ColumnProfile, Grain, Table } from "./table";

const BUDGET_NAME = /budget/iu;
/** The names the unpivoted table gives its own columns. */
const RESERVED: ReadonlySet<string> = new Set(["period", "amount", "budget"]);
const FINER_FIRST: readonly Grain[] = ["month", "quarter", "year"];

interface PeriodColumn {
  readonly column: ColumnProfile;
  readonly key: string;
  readonly grain: Grain;
}

/**
 * Unpivots when at least two numeric columns have period headers; otherwise the
 * table comes back as it was. Non-period columns are kept and repeated for each
 * period; a numeric column named like a budget becomes `budget`.
 */
export function unpivotIfWide(
  table: Table,
  options: ProfileOptions = {},
): Table {
  const periods = periodColumns(table);
  if (periods.length < 2) return table;

  const periodNames = new Set(periods.map((period) => period.column.name));
  const kept = table.columns.filter((column) => !periodNames.has(column.name));
  const budget = kept.find(
    (column) => column.type === "number" && BUDGET_NAME.test(column.name),
  );
  // Every name in the table has to stay unique, so a column that already holds
  // one of the reserved names takes the first suffix nothing else answers to.
  const taken = new Set([
    ...kept.map((column) => column.name),
    "period",
    "amount",
  ]);
  const keptNames = kept.map((column) => {
    if (column === budget) return "budget";
    if (!RESERVED.has(column.name)) return column.name;
    const free = freeName(column.name, taken);
    taken.add(free);
    return free;
  });

  const rows: string[][] = [];
  for (const row of table.rows) {
    const base = kept.map((column) => row[column.index] ?? "");
    for (const period of periods) {
      rows.push([...base, period.key, row[period.column.index] ?? ""]);
    }
  }

  const headers = [...keptNames, "period", "amount"];
  const columns = headers.map((name, index) => {
    const profile = profileColumn(
      name,
      index,
      rows.map((row) => row[index] ?? ""),
      options,
    );
    if (name === "period") return periodColumnProfile(profile);
    if (name === "amount") return amountColumnProfile(profile, periods);
    return profile;
  });

  return {
    columns,
    rows,
    rowCount: rows.length,
    unpivoted: {
      periodColumns: periods.map((period) => period.column.name),
      periodColumn: "period",
      amountColumn: "amount",
      ...(budget === undefined ? {} : { budgetColumn: "budget" as const }),
    },
  };
}

/**
 * The period column holds bucket keys, not dates, so it is text by
 * construction and carries none of the conventions a typed column carries.
 */
function periodColumnProfile(profile: ColumnProfile): ColumnProfile {
  return {
    name: profile.name,
    index: profile.index,
    type: "text",
    semanticKind: "period",
    nonEmpty: profile.nonEmpty,
    distinct: profile.distinct,
    samples: profile.samples,
  };
}

/**
 * Period headers already proved that this is a wide numeric table. Preserve
 * that numeric contract even when one period contains unreadable cells, so
 * canonical parsing can report those cells instead of losing the period.
 */
function amountColumnProfile(
  profile: ColumnProfile,
  periods: readonly PeriodColumn[],
): ColumnProfile {
  const decimals = new Set(
    periods.flatMap(({ column }) =>
      column.decimal === undefined ? [] : [column.decimal],
    ),
  );
  const currencies = new Set(
    periods.flatMap(({ column }) =>
      column.currency === undefined ? [] : [column.currency],
    ),
  );
  const decimal = [...decimals][0];
  const currency = [...currencies][0];
  return {
    name: profile.name,
    index: profile.index,
    type: "number",
    semanticKind: "measure",
    nonEmpty: profile.nonEmpty,
    distinct: profile.distinct,
    samples: profile.samples,
    ...(decimals.size === 1 && decimal !== undefined ? { decimal } : {}),
    ...(currencies.size === 1 && currency !== undefined ? { currency } : {}),
  };
}

/** `period_1`, or the next suffix no other column in the table answers to. */
function freeName(name: string, taken: ReadonlySet<string>): string {
  let suffix = 1;
  while (taken.has(`${name}_${String(suffix)}`)) suffix += 1;
  return `${name}_${String(suffix)}`;
}

/**
 * Period-headed columns at an established wide-table grain, in file order.
 * Two numeric or blank columns establish the shape. Once established, every
 * header at that grain is retained so a nonblank unreadable latest value
 * reaches canonical validation instead of disappearing with its column.
 */
function periodColumns(table: Table): readonly PeriodColumn[] {
  const candidates: PeriodColumn[] = [];
  for (const column of table.columns) {
    const parsed = parsePeriodHeader(column.name);
    if (parsed !== null) candidates.push({ column, ...parsed });
  }
  const establishing = candidates.filter(
    ({ column }) => column.type === "number" || column.nonEmpty === 0,
  );
  if (establishing.length < 2) return [];

  const counts = new Map<Grain, number>();
  for (const candidate of establishing) {
    counts.set(candidate.grain, (counts.get(candidate.grain) ?? 0) + 1);
  }
  let chosen: Grain = establishing[0]?.grain ?? "month";
  for (const grain of FINER_FIRST) {
    if ((counts.get(grain) ?? 0) > (counts.get(chosen) ?? 0)) chosen = grain;
  }
  if ((counts.get(chosen) ?? 0) < 2) return [];
  return candidates.filter((candidate) => candidate.grain === chosen);
}
