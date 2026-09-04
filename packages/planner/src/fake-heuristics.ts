/**
 * The deterministic planner's rules for reading a table and composing a
 * first dashboard from a request.
 */
import { parsePeriodHeader, type ColumnProfile, type Grain } from "./workbook";
import { findMeasurement } from "./plan";
import type { TablePlan, TableSectionKind } from "./table-plan";

export interface TableSummary {
  readonly columns: readonly ColumnProfile[];
  readonly unpivoted: boolean;
}

export type Roles = TablePlan["roles"];
export type Filter = TablePlan["filters"][number];

const AMOUNT_NAME = /amount|total|spend|cost|value|net|debit|credit/iu;
const BUDGET_NAME = /budget/iu;
const CATEGORY_NAME =
  /category|type|department|dept|line|account|vendor|class|group|label/iu;
const LABEL_NAME = /description|memo|label|name|item/iu;

export function isPeriodLike(column: ColumnProfile, unpivoted: boolean): boolean {
  if (column.type === "date") return true;
  if (unpivoted && column.name === "period") return true;
  const filled = column.samples.filter((sample) => sample !== "");
  return filled.length > 0 && filled.every((sample) => parsePeriodHeader(sample) !== null);
}

function pickAmount(columns: readonly ColumnProfile[]): ColumnProfile | undefined {
  const numbers = columns.filter((column) => column.type === "number");
  const named = numbers.find(
    (column) => AMOUNT_NAME.test(column.name) && !BUDGET_NAME.test(column.name),
  );
  if (named !== undefined) return named;
  const candidates = numbers.filter((column) => !BUDGET_NAME.test(column.name));
  return [...(candidates.length > 0 ? candidates : numbers)].sort(
    (a, b) => b.nonEmpty - a.nonEmpty || a.index - b.index,
  )[0];
}

function pickCategory(
  columns: readonly ColumnProfile[],
  taken: ReadonlySet<string>,
): ColumnProfile | undefined {
  const texts = columns.filter(
    (column) => column.type === "text" && !taken.has(column.name),
  );
  return (
    texts.find((column) => CATEGORY_NAME.test(column.name) && !LABEL_NAME.test(column.name)) ??
    texts.find((column) => CATEGORY_NAME.test(column.name)) ??
    texts.find((column) => column.distinct >= 2 && column.distinct <= 50)
  );
}

/** Which column plays which part, from names and types alone. */
export function chooseRoles(table: TableSummary): Roles {
  const { columns, unpivoted } = table;
  const amount = pickAmount(columns);
  const roles: { -readonly [K in keyof Roles]: Roles[K] } = {
    amount: amount?.name ?? columns[0]?.name ?? "amount",
  };
  const taken = new Set<string>([roles.amount]);

  const budget = columns.find(
    (column) => column.type === "number" && BUDGET_NAME.test(column.name) && !taken.has(column.name),
  );
  if (budget !== undefined) {
    roles.budget = budget.name;
    taken.add(budget.name);
  }

  const period = columns.find(
    (column) => !taken.has(column.name) && isPeriodLike(column, unpivoted),
  );
  if (period !== undefined) {
    roles.period = period.name;
    taken.add(period.name);
  }

  const category = pickCategory(columns, taken);
  if (category !== undefined) {
    roles.category = category.name;
    taken.add(category.name);
  }

  const label = columns.find(
    (column) => column.type === "text" && !taken.has(column.name) && LABEL_NAME.test(column.name),
  );
  if (label !== undefined) roles.label = label.name;

  return roles;
}

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, eighteen: 18, twenty: 20, thirty: 30,
};

/** "last 12 months" → 12 periods at month grain. */
export function readLastPeriods(text: string): { count: number; grain: Grain } | undefined {
  const match = /\blast\s+(\d{1,2}|[a-z]+)\s+(months?|quarters?|years?)\b/iu.exec(text);
  if (match === null) return undefined;
  const word = (match[1] as string).toLowerCase();
  const count = /^\d+$/u.test(word) ? Number(word) : NUMBER_WORDS[word];
  if (count === undefined || count < 2 || count > 60) return undefined;
  const unit = (match[2] as string).toLowerCase();
  const grain: Grain = unit.startsWith("quarter") ? "quarter" : unit.startsWith("year") ? "year" : "month";
  return { count, grain };
}

export function readGrain(text: string): Grain | undefined {
  if (/\bquarter(?:ly|s)?\b/iu.test(text)) return "quarter";
  if (/\b(?:annual(?:ly)?|year(?:ly)?)\b/iu.test(text)) return "year";
  if (/\bmonth(?:ly|s)?\b/iu.test(text)) return "month";
  return undefined;
}

/**
 * "exclude X", "without X", "only X", "just X" where X is a category value
 * the profile shows. The phrase stops at punctuation or a joining word.
 */
export function readFilters(
  text: string,
  category: ColumnProfile | undefined,
): Filter[] {
  if (category === undefined) return [];
  const filters: Filter[] = [];
  const pattern =
    /\b(exclude|excluding|without|only|just)\s+(?:the\s+)?([^,.;]+?)(?=\s+(?:and|but|for|over|by|in|from|with)\b|[,.;]|$)/giu;
  for (const match of text.matchAll(pattern)) {
    const keyword = (match[1] as string).toLowerCase();
    const phrase = (match[2] as string).trim().toLowerCase();
    const values = category.samples.filter(
      (sample) => sample !== "" && (phrase.includes(sample.toLowerCase()) || sample.toLowerCase().includes(phrase)),
    );
    if (values.length === 0) continue;
    const op = keyword === "only" || keyword === "just" ? "include" : "exclude";
    const existing = filters.find((filter) => filter.op === op);
    if (existing === undefined) {
      filters.push({ column: category.name, op, values });
    } else {
      existing.values.push(...values.filter((value) => !existing.values.includes(value)));
    }
  }
  return filters;
}

const OVERVIEW: TableSectionKind[] = ["summary", "headline-totals", "by-category", "trend"];
const DETAIL: TableSectionKind[] = ["movers", "largest-rows", "table"];

/** The section the request leads with, if it names one. */
export function leadSection(text: string, roles: Roles): TableSectionKind | undefined {
  if (/\b(?:largest|biggest|top)\b/iu.test(text)) return "largest-rows";
  if (/\btrend|over time\b/iu.test(text)) return "trend";
  if (roles.budget !== undefined && /\bbudget/iu.test(text)) return "budget-variance";
  return undefined;
}

/** Drops the sections the roles cannot support. */
export function supported(sections: readonly TableSectionKind[], roles: Roles): TableSectionKind[] {
  return sections.filter((section) => {
    if (section === "by-category") return roles.category !== undefined;
    if (section === "movers") return roles.category !== undefined && roles.period !== undefined;
    if (section === "trend") return roles.period !== undefined;
    if (section === "budget-variance") return roles.budget !== undefined;
    return true;
  });
}

function titleFrom(sourceName: string): string {
  const stem = sourceName.replace(/\.[a-z0-9]+$/iu, "").replace(/[-_]+/gu, " ").trim();
  if (stem === "" || findMeasurement(stem) !== undefined) return "Spend overview";
  return `${stem.charAt(0).toUpperCase()}${stem.slice(1)} overview`;
}

export function defaultPlan(
  requestText: string,
  sourceName: string,
  roles: Roles,
  table: TableSummary,
): TablePlan {
  const last = readLastPeriods(requestText);
  const grain = readGrain(requestText) ?? last?.grain ?? "month";
  const category = table.columns.find((column) => column.name === roles.category);

  let overview = supported(OVERVIEW, roles);
  const detail = supported(DETAIL, roles);
  if (roles.budget !== undefined) overview.push("budget-variance");
  const lead = leadSection(requestText, roles);
  if (lead !== undefined) {
    overview = [lead, ...overview.filter((section) => section !== lead)];
    const index = detail.indexOf(lead);
    if (index !== -1) detail.splice(index, 1);
  }

  const pages: TablePlan["pages"] = [
    {
      id: "overview",
      title: "Overview",
      description: "Totals for the latest period, how they compare with the one before, and where the money went.",
      sections: overview.slice(0, 6),
    },
  ];
  if (detail.length > 0) {
    pages.push({
      id: "detail",
      title: "Detail",
      description: "The lines that moved most, the largest single rows, and the rows themselves.",
      sections: detail.slice(0, 6),
    });
  }

  return {
    planVersion: "table-plan-v1",
    title: titleFrom(sourceName),
    audience: "Whoever asked for this view of the file",
    framing: "Totals first, then the breakdown by category and the rows behind it.",
    roles,
    grain,
    filters: readFilters(requestText, category),
    ...(last === undefined ? {} : { lastPeriods: last.count }),
    pages,
  };
}
