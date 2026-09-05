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
    return name === "period" ? periodColumnProfile(profile) : profile;
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

/** `period_1`, or the next suffix no other column in the table answers to. */
function freeName(name: string, taken: ReadonlySet<string>): string {
  let suffix = 1;
  while (taken.has(`${name}_${String(suffix)}`)) suffix += 1;
  return `${name}_${String(suffix)}`;
}

/** The numeric period-headed columns at the most common grain, in file order. */
function periodColumns(table: Table): readonly PeriodColumn[] {
  const candidates: PeriodColumn[] = [];
  for (const column of table.columns) {
    if (column.type !== "number" && column.nonEmpty > 0) continue;
    const parsed = parsePeriodHeader(column.name);
    if (parsed !== null) candidates.push({ column, ...parsed });
  }
  if (candidates.length === 0) return candidates;

  const counts = new Map<Grain, number>();
  for (const candidate of candidates) {
    counts.set(candidate.grain, (counts.get(candidate.grain) ?? 0) + 1);
  }
  let chosen: Grain = candidates[0]?.grain ?? "month";
  for (const grain of FINER_FIRST) {
    if ((counts.get(grain) ?? 0) > (counts.get(chosen) ?? 0)) chosen = grain;
  }
  return candidates.filter((candidate) => candidate.grain === chosen);
}
