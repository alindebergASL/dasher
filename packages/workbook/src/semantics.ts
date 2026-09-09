/** Deterministic, source-neutral semantic classification for table columns. */
import { parsePeriodHeader } from "./parse-values";
import type { ColumnSemanticKind, ColumnType } from "./table";

export interface SemanticColumnInput {
  readonly name: string;
  readonly type: ColumnType;
  readonly nonEmpty: number;
  readonly samples: readonly string[];
  readonly currency?: string;
}

const IDENTIFIERS = new Set(["id", "identifier", "uuid", "guid"]);
const CODES = new Set(["code", "key", "reference", "ref"]);
const ORDINALS = new Set(["rank", "ordinal", "sequence", "position", "index"]);
const IDENTIFIER_NUMBER_PREFIXES = new Set([
  "account",
  "chassis",
  "customer",
  "employee",
  "invoice",
  "order",
  "phone",
  "session",
]);
const PERIODS = new Set([
  "date",
  "day",
  "week",
  "month",
  "quarter",
  "period",
  "year",
]);
const MEASURES = new Set([
  "amount",
  "balance",
  "betrag",
  "budget",
  "cost",
  "count",
  "headcount",
  "percent",
  "percentage",
  "quantity",
  "qty",
  "rate",
  "revenue",
  "spend",
  "total",
  "units",
]);

/** Split punctuation, separators and camelCase without substring guessing. */
export function normalizedHeaderTokens(name: string): readonly string[] {
  return name
    .normalize("NFKC")
    .replace(/([\p{Ll}\d])(\p{Lu})/gu, "$1 $2")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token !== "");
}

function endsWith(
  tokens: readonly string[],
  words: ReadonlySet<string>,
): boolean {
  const last = tokens.at(-1);
  return last !== undefined && words.has(last);
}

function hasToken(
  tokens: readonly string[],
  words: ReadonlySet<string>,
): boolean {
  return tokens.some((token) => words.has(token));
}

function isIdentifierNumber(tokens: readonly string[]): boolean {
  const suffix = tokens.at(-1);
  if (suffix !== "number" && suffix !== "no") return false;
  const subject = tokens.at(-2);
  return subject !== undefined && IDENTIFIER_NUMBER_PREFIXES.has(subject);
}

function valuesNamePeriods(samples: readonly string[]): boolean {
  const filled = samples.filter((sample) => sample !== "");
  return (
    filled.length > 0 &&
    filled.every((sample) => parsePeriodHeader(sample) !== null)
  );
}

/**
 * Classify from exact normalized header words plus already-typed values.
 *
 * The exclusions carry the safety: a column that names an identifier, a code,
 * an ordinal or a period is claimed by those rules first, and only what
 * survives them can be a measure. Once they have had their say, a numeric
 * column is a measure, whatever it counts — hours, tickets, millimetres of
 * rain. Currency and explicit measure words are shortcuts to that answer, not
 * the price of admission to it.
 *
 * An earlier version required one of sixteen mostly financial header words, so
 * every numeric column outside accounting fell to "unknown" and the planner
 * refused the file for having no usable measure. A harness that builds a
 * dashboard from anything cannot hold a list of the nouns it will measure.
 */
export function classifyColumnSemantic(
  column: SemanticColumnInput,
): ColumnSemanticKind {
  const tokens = normalizedHeaderTokens(column.name);

  if (
    endsWith(tokens, IDENTIFIERS) ||
    isIdentifierNumber(tokens) ||
    (tokens.length === 1 && tokens[0] === "phone")
  )
    return "identifier";
  if (endsWith(tokens, CODES) || hasToken(tokens, new Set(["sku", "zip"])))
    return "code";
  if (endsWith(tokens, ORDINALS)) return "ordinal";
  if (column.type === "date" || endsWith(tokens, PERIODS)) return "period";
  if (column.currency !== undefined || hasToken(tokens, MEASURES)) {
    return "measure";
  }
  // Numbers that spell out periods ("2024", "2026-03") are the calendar, not a
  // quantity, so this must stay ahead of the numeric rule below.
  if (valuesNamePeriods(column.samples)) return "period";
  if (column.type === "number") return "measure";
  return column.nonEmpty === 0 ? "unknown" : "dimension";
}
