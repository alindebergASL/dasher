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
  /**
   * Every distinct value of the columns small enough to list, by column name.
   * A profile shows five samples; without this a sixth value cannot be filtered.
   */
  readonly values?: Readonly<Record<string, readonly string[]>>;
}

export type Roles = TablePlan["roles"];
export type Filter = TablePlan["filters"][number];

export class NoSafeMeasureError extends Error {
  constructor() {
    super("The dataset has no column that can safely be used as a measure.");
    this.name = "NoSafeMeasureError";
  }
}

/** A deterministic measure candidate must pass both canonical type and semantics. */
export function isSafeMeasureColumn(column: ColumnProfile): boolean {
  return column.type === "number" && column.semanticKind === "measure";
}

const BUDGET_NAME = /budget/iu;
const CATEGORY_NAME =
  /category|type|department|dept|line|account|vendor|class|group|label/iu;
const LABEL_NAME = /description|memo|label|name|item/iu;
const ID_NAME = /(?:^|_| )id$/iu;

export function isPeriodLike(
  column: ColumnProfile,
  unpivoted: boolean,
): boolean {
  if (column.semanticKind === "period") return true;
  if (unpivoted && column.name === "period") return true;
  return false;
}

function pickAmount(
  columns: readonly ColumnProfile[],
): ColumnProfile | undefined {
  const measures = columns.filter(isSafeMeasureColumn);
  const candidates = measures.filter(
    (column) => !BUDGET_NAME.test(column.name),
  );
  return [...(candidates.length > 0 ? candidates : measures)].sort(
    (a, b) => b.nonEmpty - a.nonEmpty || a.index - b.index,
  )[0];
}

function pickCategory(
  columns: readonly ColumnProfile[],
  taken: ReadonlySet<string>,
): ColumnProfile | undefined {
  const texts = columns.filter(
    (column) =>
      column.type === "text" &&
      column.semanticKind === "dimension" &&
      !taken.has(column.name),
  );
  // An id column is a key, not a name a reader wants to see, so it loses to any other candidate.
  const readable = texts.filter((column) => !ID_NAME.test(column.name));
  const pool = readable.length > 0 ? readable : texts;
  return (
    pool.find((column) => CATEGORY_NAME.test(column.name)) ??
    pool.find((column) => column.distinct >= 2 && column.distinct <= 50) ??
    texts.find((column) => CATEGORY_NAME.test(column.name))
  );
}

/** Which column plays which part, from names and types alone. */
export function chooseRoles(table: TableSummary): Roles {
  const { columns, unpivoted } = table;
  const amount = pickAmount(columns);
  if (amount === undefined) {
    throw new NoSafeMeasureError();
  }
  const roles: { -readonly [K in keyof Roles]: Roles[K] } = {
    amount: amount.name,
  };
  const taken = new Set<string>([roles.amount]);

  const budget = columns.find(
    (column) =>
      isSafeMeasureColumn(column) &&
      BUDGET_NAME.test(column.name) &&
      !taken.has(column.name),
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
    (column) =>
      column.type === "text" &&
      column.semanticKind === "dimension" &&
      !taken.has(column.name) &&
      LABEL_NAME.test(column.name),
  );
  if (label !== undefined) roles.label = label.name;

  return roles;
}

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  eighteen: 18,
  twenty: 20,
  thirty: 30,
};

/** "last 12 months" → 12 periods at month grain. */
export function readLastPeriods(
  text: string,
): { count: number; grain: Grain } | undefined {
  const match =
    /\blast\s+(\d{1,2}|[a-z]+)\s+(months?|quarters?|years?)\b/iu.exec(text);
  if (match === null) return undefined;
  const word = (match[1] as string).toLowerCase();
  const count = /^\d+$/u.test(word) ? Number(word) : NUMBER_WORDS[word];
  if (count === undefined || count < 2 || count > 60) return undefined;
  const unit = (match[2] as string).toLowerCase();
  const grain: Grain = unit.startsWith("quarter")
    ? "quarter"
    : unit.startsWith("year")
      ? "year"
      : "month";
  return { count, grain };
}

export function readGrain(text: string): Grain | undefined {
  if (/\bquarter(?:ly|s)?\b/iu.test(text)) return "quarter";
  if (/\b(?:annual(?:ly)?|year(?:ly)?)\b/iu.test(text)) return "year";
  if (/\bmonth(?:ly|s)?\b/iu.test(text)) return "month";
  return undefined;
}

/**
 * The phrase runs to punctuation or the end of the instruction, not to the
 * next joining word. Stopping at "and" reads "exclude salaries and benefits"
 * as "salaries", which names no category, so the instruction silently did
 * nothing. Category names containing "and" are ordinary. Narrowing the phrase
 * is `matchValues`' job, and it matches whole values and whole words only.
 */
const FILTER_PHRASE =
  /\b(exclude|excluding|without|only|just|drop|remove|hide|delete)\s+(?:the\s+)?([^,.;]+)/giu;
const INCLUDE_WORDS = new Set(["only", "just"]);
/**
 * A phrase that is ENTIRELY a time expression, rather than one that merely
 * mentions a unit. "the last 2 quarters" is a window; "travel for the quarter"
 * names a category and happens to say when. Testing for a time word anywhere
 * suppressed the second along with the first.
 */
const TIME_WINDOW =
  /^(?:the\s+)?(?:last|past|previous|next|first|latest|this|current)?\s*\d*\s*(?:second|minute|hour|day|week|month|quarter|year|period|ytd)s?$/iu;

function normalise(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, " ");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** RULE: a time window is a period, never a category filter. */
function isTimeWindow(phrase: string): boolean {
  return TIME_WINDOW.test(phrase.trim()) || parsePeriodHeader(phrase) !== null;
}

/**
 * The values a filter may name in a column.
 *
 * RULE: only values that are actually listed. Where the caller has the column's
 * distinct values, all of them; otherwise the profile's five samples, and a
 * value beyond them simply cannot be filtered.
 */
export function filterValues(
  table: TableSummary,
  column: ColumnProfile | undefined,
): readonly string[] {
  if (column === undefined) return [];
  return (table.values?.[column.name] ?? column.samples).filter(
    (value) => value.trim() !== "",
  );
}

/**
 * The values a phrase names.
 *
 * RULE: a phrase names a value only by saying the whole of it — as the whole
 * phrase, or as whole words within it. Never a substring in either direction,
 * so "travel" cannot pick "A", and "marketing" cannot pick "IN".
 */
export function matchValues(
  phrase: string,
  values: readonly string[],
): string[] {
  const text = normalise(phrase);
  if (text === "" || isTimeWindow(text)) return [];
  return values.filter((value) => {
    const target = normalise(value);
    if (target === "") return false;
    if (target === text) return true;
    return new RegExp(
      `(?<![\\p{L}\\p{N}])${escapeRegExp(target)}(?![\\p{L}\\p{N}])`,
      "u",
    ).test(text);
  });
}

/**
 * "exclude X", "without X", "only X", "just X", "drop X", where X names values
 * the column lists. A phrase that names none of them emits no filter.
 */
export function readFilters(
  text: string,
  category: ColumnProfile | undefined,
  known?: readonly string[],
): Filter[] {
  if (category === undefined) return [];
  const listed = (known ?? category.samples).filter(
    (value) => value.trim() !== "",
  );
  const filters: Filter[] = [];
  for (const match of text.matchAll(FILTER_PHRASE)) {
    const keyword = (match[1] as string).toLowerCase();
    const values = matchValues(match[2] as string, listed);
    if (values.length === 0) continue;
    const op = INCLUDE_WORDS.has(keyword) ? "include" : "exclude";
    const existing = filters.find((filter) => filter.op === op);
    if (existing === undefined) {
      filters.push({ column: category.name, op, values });
    } else {
      existing.values.push(
        ...values.filter((value) => !existing.values.includes(value)),
      );
    }
  }
  return filters;
}

const OVERVIEW: TableSectionKind[] = [
  "summary",
  "headline-totals",
  "by-category",
  "trend",
];
const DETAIL: TableSectionKind[] = ["movers", "largest-rows", "table"];

/** The section the request leads with, if it names one. */
export function leadSection(
  text: string,
  roles: Roles,
): TableSectionKind | undefined {
  if (/\b(?:largest|biggest|top)\b/iu.test(text)) return "largest-rows";
  if (/\btrend|over time\b/iu.test(text)) return "trend";
  if (roles.budget !== undefined && /\bbudget/iu.test(text))
    return "budget-variance";
  return undefined;
}

/** Drops the sections the roles cannot support. */
export function supported(
  sections: readonly TableSectionKind[],
  roles: Roles,
): TableSectionKind[] {
  return sections.filter((section) => {
    if (section === "relationship")
      return roles.comparison !== undefined && roles.period !== undefined;
    if (section === "by-category") return roles.category !== undefined;
    if (section === "movers")
      return roles.category !== undefined && roles.period !== undefined;
    if (section === "trend") return roles.period !== undefined;
    if (section === "budget-variance") return roles.budget !== undefined;
    return true;
  });
}

/** A title that reflects what was asked without changing the measure's meaning. */
function titleFrom(
  requestText: string,
  sourceName: string,
  roles: Roles,
  measureLabel: string,
  explicitCashFlow: boolean,
): string {
  const asked = requestText.toLowerCase();
  if (explicitCashFlow && roles.category !== undefined) {
    return `${measureLabel} by ${roles.category}`;
  }
  if (roles.comparison !== undefined) {
    return `${measureLabel} vs ${roles.comparison}`;
  }
  if (roles.budget !== undefined && /budget|variance|over\b/u.test(asked)) {
    return !explicitCashFlow ? "Budget check" : `${measureLabel} budget check`;
  }
  if (/largest|biggest|top\b|movers?/u.test(asked)) {
    return !explicitCashFlow
      ? "Largest items and biggest movers"
      : `${measureLabel}: largest items and biggest movers`;
  }
  if (/trend|over time|month by month|quarter|year/u.test(asked)) {
    return `${measureLabel} over time`;
  }
  if (/categor|where.*going|breakdown|mix/u.test(asked)) {
    return roles.category === undefined
      ? `${measureLabel} breakdown`
      : `${measureLabel} by ${roles.category}`;
  }
  if (explicitCashFlow) return `${measureLabel} overview`;
  const stem = sourceName
    .replace(/\.[a-z0-9]+$/iu, "")
    .replace(/[-_]+/gu, " ")
    .trim();
  if (stem === "" || findMeasurement(stem) !== undefined)
    return `${roles.amount} overview`;
  return `${stem.charAt(0).toUpperCase()}${stem.slice(1)} overview`;
}

export function chooseRelationshipRoles(
  text: string,
  roles: TablePlan["roles"],
  table: TableSummary,
): TablePlan["roles"] {
  if (!/\b(?:compare|comparison|relationship|versus|vs\.?)\b/iu.test(text)) {
    return roles;
  }
  const matches = table.columns
    .filter(isSafeMeasureColumn)
    .map((column) => {
      const escaped = column.name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      const match = new RegExp(
        `(?:^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`,
        "iu",
      ).exec(text);
      return match === null ? null : { column, index: match.index };
    })
    .filter((match): match is NonNullable<typeof match> => match !== null)
    .sort((left, right) => left.index - right.index);
  if (matches.length !== 2) return roles;
  const [primary, comparison] = matches;
  if (primary === undefined || comparison === undefined) return roles;
  return {
    ...roles,
    amount: primary.column.name,
    comparison: comparison.column.name,
  };
}

function relationshipOperation(
  text: string,
  roles: TablePlan["roles"],
): NonNullable<TablePlan["relationship"]>["operation"] {
  if (/\b(?:per|ratio|efficien(?:cy|t))\b/iu.test(text)) return "ratio";
  const pair = new Set(
    [roles.amount, roles.comparison]
      .filter((name): name is string => name !== undefined)
      .map((name) => name.trim().toLocaleLowerCase("en-US")),
  );
  return pair.size === 2 && pair.has("customers") && pair.has("headcount")
    ? "ratio"
    : "compare";
}

function asksForDirectionalFlow(text: string): boolean {
  const normalized = text.replace(/[-‐‑–—]/gu, " ");
  const mention =
    /\b(?:cash flows?|cash movement|signed flows?|inflows?(?:\s+(?:and|versus|vs\.?)\s+outflows?)?|outflows?(?:\s+(?:and|versus|vs\.?)\s+inflows?)?)\b/giu;
  for (const match of normalized.matchAll(mention)) {
    const before = normalized.slice(0, match.index);
    const clauseStart = Math.max(
      before.lastIndexOf("."),
      before.lastIndexOf(","),
      before.lastIndexOf(";"),
      before.lastIndexOf(":"),
      before.lastIndexOf("!"),
      before.lastIndexOf("?"),
    );
    const clausePrefix = before.slice(clauseStart + 1);
    const contrast = [
      ...clausePrefix.matchAll(/\b(?:but|instead(?!\s+of\b))\b/giu),
    ].at(-1);
    const relevantPrefix =
      contrast === undefined
        ? clausePrefix
        : clausePrefix.slice(contrast.index + contrast[0].length);
    if (
      /\b(?:not|no|without|avoid(?:ing)?|exclude|excluding|rather than|do not|don't)\b/iu.test(
        relevantPrefix,
      )
    ) {
      continue;
    }
    return true;
  }
  return false;
}

export function defaultPlan(
  requestText: string,
  sourceName: string,
  roles: Roles,
  table: TableSummary,
): TablePlan {
  const explicitCashFlow = asksForDirectionalFlow(requestText);
  const measureLabel = explicitCashFlow ? "Cash flow" : roles.amount;
  const last = readLastPeriods(requestText);
  const grain = readGrain(requestText) ?? last?.grain ?? "month";
  const category = table.columns.find(
    (column) => column.name === roles.category,
  );

  const relationship =
    roles.comparison === undefined
      ? undefined
      : ({ operation: relationshipOperation(requestText, roles) } as const);
  let overview =
    relationship === undefined
      ? supported(OVERVIEW, roles)
      : ["relationship" as const, ...supported(["by-category"], roles)];
  if (explicitCashFlow) {
    overview = overview.filter((section) => section !== "summary");
  }
  const detail = supported(
    relationship === undefined ? DETAIL : ["largest-rows", "table"],
    roles,
  );
  if (roles.budget !== undefined) overview.push("budget-variance");
  const lead =
    roles.comparison === undefined
      ? leadSection(requestText, roles)
      : "relationship";
  if (lead !== undefined) {
    overview = [lead, ...overview.filter((section) => section !== lead)];
    const index = detail.indexOf(lead);
    if (index !== -1) detail.splice(index, 1);
  }

  const pages: TablePlan["pages"] = [
    {
      id: "overview",
      title: "Overview",
      description: explicitCashFlow
        ? `Gross inflow, gross outflow, net movement, and ${roles.category === undefined ? "the rows behind them" : `the directional breakdown by ${roles.category}`}.`
        : relationship === undefined
          ? `Latest ${measureLabel}, its change from the prior period, and ${roles.category === undefined ? "the contributing rows" : `the breakdown by ${roles.category}`}.`
          : relationship.operation === "ratio"
            ? `Latest ${measureLabel} and ${roles.comparison}, both prior-period changes, and ${measureLabel} per ${roles.comparison}.`
            : `Latest ${measureLabel} and ${roles.comparison} with both prior-period changes.`,
      sections: overview.slice(0, 6),
    },
  ];
  if (detail.length > 0) {
    pages.push({
      id: "detail",
      title: "Detail",
      description:
        "The lines that moved most, the largest single rows, and the rows themselves.",
      sections: detail.slice(0, 6),
    });
  }

  return {
    planVersion: "table-plan-v1",
    title: titleFrom(
      requestText,
      sourceName,
      roles,
      measureLabel,
      explicitCashFlow,
    ),
    audience: "Whoever asked for this view of the dataset",
    framing:
      roles.comparison === undefined
        ? `${measureLabel} first, then ${roles.category === undefined ? "the rows behind it" : `the breakdown by ${roles.category} and the rows behind it`}.`
        : `${measureLabel} and ${roles.comparison} first, then the relationship and the rows behind it.`,
    roles,
    ...(relationship === undefined ? {} : { relationship }),
    ...(explicitCashFlow ? { flow: { operation: "gross-net" as const } } : {}),
    grain,
    filters: readFilters(requestText, category, filterValues(table, category)),
    ...(last === undefined ? {} : { lastPeriods: last.count }),
    pages,
  };
}
