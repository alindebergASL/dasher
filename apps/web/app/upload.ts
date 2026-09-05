import { createHash } from "node:crypto";

import {
  CSV_LIMITS,
  detectDelimiter,
  normalizedHeaderTokens,
  parseCsv,
  readTable,
  TableRefused,
  type CsvTable,
  type Table,
} from "@dasher/workbook";

import { UPLOAD_MAX_BYTES } from "./planning";

export { UPLOAD_MAX_BYTES };

/**
 * Rows the reader may end up with, which is not the same as rows in the file.
 * A wide export is unpivoted to one row per line and period, so a legal 4 MB
 * file with many period columns multiplies out. Bounding the input alone left
 * a 4 MB upload expanding to millions of rows on the request thread.
 */
export const MAX_TABLE_ROWS = 200_000;
export const CREDENTIAL_REFUSAL_MESSAGE =
  "This dataset can't be used because it may contain credentials. Remove sensitive fields and try again. The current dashboard is unchanged.";

export type UploadRefusal =
  | { readonly kind: "no_file" }
  | { readonly kind: "too_large"; readonly bytes: number }
  | { readonly kind: "not_utf8" }
  | { readonly kind: "too_many_rows"; readonly rows: number }
  | { readonly kind: "credentials" }
  | { readonly kind: "unreadable"; readonly detail: string };

export function uploadRefusalMessage(refusal: UploadRefusal): string {
  switch (refusal.kind) {
    case "no_file":
      return "Choose a CSV file to build a dashboard from.";
    case "too_large":
      return `That file is bigger than the ${String(Math.floor(UPLOAD_MAX_BYTES / (1024 * 1024)))} MB this accepts. Yours is ${String(Math.ceil(refusal.bytes / (1024 * 1024)))} MB.`;
    case "not_utf8":
      return "That file is not UTF-8 text. Export it as CSV (UTF-8) and try again.";
    case "too_many_rows":
      return `That file works out to ${refusal.rows.toLocaleString("en-US")} rows once each period is read separately, and this reads at most ${MAX_TABLE_ROWS.toLocaleString("en-US")}. Send fewer periods or fewer lines.`;
    case "credentials":
      return CREDENTIAL_REFUSAL_MESSAGE;
    case "unreadable":
      return `That file could not be read as a table. ${refusal.detail}`;
  }
}

const CREDENTIAL_HEADER_WORDS = new Set([
  "authorization",
  "cookie",
  "credential",
  "credentials",
  "password",
  "secret",
  "session",
  "token",
]);

const CREDENTIAL_HEADER_PHRASES: readonly (readonly string[])[] = [
  ["api", "key"],
  ["x", "api", "key"],
  ["private", "key"],
  ["client", "secret"],
  ["access", "token"],
  ["refresh", "token"],
  ["auth", "token"],
  ["session", "id"],
  ["session", "key"],
  ["session", "secret"],
  ["session", "token"],
  ["password", "hash"],
  ["password", "value"],
  ["authorization", "header"],
  ["authorization", "token"],
  ["cookie", "header"],
  ["cookie", "value"],
];

const BENIGN_CREDENTIAL_HEADER_PHRASES: readonly (readonly string[])[] = [
  ["token", "count"],
  ["session", "duration"],
  ["cookie", "preference"],
  ["authorization", "status"],
  ["password", "reset", "required"],
  ["secret", "santa", "budget"],
];

function containsWords(
  tokens: readonly string[],
  phrase: readonly string[],
): boolean {
  return tokens.some((_, start) =>
    phrase.every((word, offset) => tokens[start + offset] === word),
  );
}

function isCredentialHeader(name: string): boolean {
  const tokens = normalizedHeaderTokens(name);
  if (
    BENIGN_CREDENTIAL_HEADER_PHRASES.some(
      (phrase) =>
        tokens.length === phrase.length && containsWords(tokens, phrase),
    )
  )
    return false;
  if (tokens.some((token) => CREDENTIAL_HEADER_WORDS.has(token))) return true;
  return CREDENTIAL_HEADER_PHRASES.some((phrase) =>
    containsWords(tokens, phrase),
  );
}

/** Deliberately narrow signatures that identify an encoded credential itself. */
function isCredentialValue(value: string): boolean {
  const trimmed = value.trim();
  return (
    /^(?:Bearer)\s+[A-Za-z0-9._~+/=-]{16,}$/iu.test(trimmed) ||
    /^(?:Basic)\s+[A-Za-z0-9+/]{12,}={0,2}$/iu.test(trimmed) ||
    /^-----BEGIN (?:EC |OPENSSH |RSA )?PRIVATE KEY-----/u.test(trimmed) ||
    /^eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/u.test(
      trimmed,
    ) ||
    /^(?:AKIA|ASIA|AIDA|AROA)[A-Z0-9]{16}$/u.test(trimmed) ||
    /^gh[pousr]_[A-Za-z0-9]{36,255}$/u.test(trimmed) ||
    /^github_pat_[A-Za-z0-9_]{20,255}$/u.test(trimmed) ||
    /^xox(?:[abprs]-[A-Za-z0-9-]{20,}|c-[A-Za-z0-9-]{20,})$/u.test(trimmed) ||
    /^sk_(?:live|test)_[A-Za-z0-9]{20,}$/u.test(trimmed) ||
    /^sk-(?:proj|svcacct)-[A-Za-z0-9_-]{20,}$/u.test(trimmed) ||
    /^sk-ant-[A-Za-z0-9_-]{20,}$/u.test(trimmed) ||
    /^AIza[A-Za-z0-9_-]{35}$/u.test(trimmed)
  );
}

/** Must run before the canonical table can reach planning or compilation. */
function containsCredentials(table: CsvTable): boolean {
  return (
    table.headers.some((header) => isCredentialHeader(header)) ||
    table.rows.some((row) => row.some((value) => isCredentialValue(value)))
  );
}

export interface ReadUpload {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly table: Table;
}

/** Turn uploaded bytes into a Table, or say plainly why not. */
export function readUpload(
  name: string,
  bytes: Uint8Array,
): { ok: true; upload: ReadUpload } | { ok: false; message: string } {
  if (bytes.byteLength === 0) {
    return { ok: false, message: uploadRefusalMessage({ kind: "no_file" }) };
  }
  if (bytes.byteLength > UPLOAD_MAX_BYTES) {
    return {
      ok: false,
      message: uploadRefusalMessage({
        kind: "too_large",
        bytes: bytes.byteLength,
      }),
    };
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, message: uploadRefusalMessage({ kind: "not_utf8" }) };
  }
  try {
    const parsed = parseCsv(text, CSV_LIMITS, detectDelimiter(text));
    if (containsCredentials(parsed)) {
      return {
        ok: false,
        message: uploadRefusalMessage({ kind: "credentials" }),
      };
    }
    const table = readTable(text);
    if (table.rowCount > MAX_TABLE_ROWS) {
      return {
        ok: false,
        message: uploadRefusalMessage({
          kind: "too_many_rows",
          rows: table.rowCount,
        }),
      };
    }
    return {
      ok: true,
      upload: {
        name,
        bytes,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        table,
      },
    };
  } catch (error) {
    const detail =
      error instanceof TableRefused
        ? error.message
        : "It does not look like comma, semicolon, or tab separated text with a header row.";
    return {
      ok: false,
      message: uploadRefusalMessage({ kind: "unreadable", detail }),
    };
  }
}
