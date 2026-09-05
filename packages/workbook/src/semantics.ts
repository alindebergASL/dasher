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
 * Known keys and ordinals win over measure hints, then explicit measure names
 * and currency provide positive evidence. A merely numeric column is unknown.
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
  // "Customers" is commonly either a customer-name dimension or a numeric
  // customer count. Only the profiled value type can safely distinguish them.
  if (
    column.type === "number" &&
    tokens.length === 1 &&
    tokens[0] === "customers"
  ) {
    return "measure";
  }
  if (column.currency !== undefined || hasToken(tokens, MEASURES)) {
    return "measure";
  }
  if (valuesNamePeriods(column.samples)) return "period";
  if (column.type === "number") return "unknown";
  return column.nonEmpty === 0 ? "unknown" : "dimension";
}
