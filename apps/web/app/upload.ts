import {
  CsvRefused,
  LedgerSourceSchema,
  ledgerFromCsv,
  type CsvRefusal,
  type LedgerSnapshot,
  type LedgerSource,
} from "@dasher/ledger-domain";
import { z } from "zod";

import { REQUEST_MAX_LENGTH } from "./planning";

/**
 * Turning an uploaded file into a ledger snapshot, and refusing it in words.
 *
 * WHY THIS IS NOT IN `actions.ts`. A `"use server"` module may export nothing
 * but async functions, and everything here is a decision rather than an
 * effect: what a file is allowed to be, what the reader must declare about it,
 * and what each refusal says to the person who has to go and fix their export.
 * Separated, it is also testable without a request — which is how the
 * message-per-reason table below came to be exhaustive rather than a switch
 * with a default.
 *
 * WHAT IS TRUSTED HERE, WHICH IS NOTHING. A server action is a public endpoint.
 * The bytes, the filename, the declared currency and the export date all arrive
 * from a browser; each is bounded, parsed, and used only as what it is. The
 * filename in particular is recorded as the client's claim about the file and
 * is never used to open, name, or route anything.
 */

/**
 * The largest file this accepts, which is the CSV reader's own byte limit.
 *
 * Restated rather than imported, because importing it would make the web app
 * depend on `@dasher/workbook` to hold one number — and the app does not read
 * CSVs, `@dasher/ledger-domain` does. `upload.test.ts` asserts the two agree,
 * so a change to either is caught by a failing test rather than by a file being
 * refused with the wrong message.
 *
 * ABOVE THIS THERE IS A SECOND, COARSER LIMIT AND IT IS NOT OURS. Next.js
 * bounds a server action's request body before any of this code runs;
 * `next.config.ts` sets that ceiling above this one on purpose, so a file that
 * is merely too large gets the sentence below rather than a framework error. A
 * file large enough to pass THAT ceiling is refused by the framework with a
 * message nobody here wrote, which is the correct trade: buffering an
 * unbounded body to produce a nicer refusal is how a server runs out of memory.
 */
export const UPLOAD_MAX_BYTES = 4 * 1024 * 1024;

/**
 * What the reader has to declare, because the file cannot say it.
 *
 * A CSV carries cells. It does not carry what it is called, what currency its
 * figures are in, what one column means, or when it was exported — and every
 * one of those appears on the dashboard. Deriving them from the filename or
 * from the clock would be a fabrication in the trusted layer, so they are asked
 * for, and a missing one refuses the upload rather than getting a default.
 */
export const LedgerUploadSchema = z.strictObject({
  /** What the reader wants built, the same brief the typed path takes. */
  request: z.string().trim().min(1).max(REQUEST_MAX_LENGTH),
  sourceName: z.string().trim().min(1).max(120),
  /**
   * ISO 4217, upper-cased on read. Three letters is the whole check: this is
   * not the place to hold a list of the world's currencies, and a wrong-but-
   * well-formed code shows up as itself on the dashboard rather than as a
   * number with no unit.
   */
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/u, "a currency is three letters, e.g. USD"),
  /** What one column is, in the reader's words: "month", "quarter". */
  periodLabel: z.string().trim().min(1).max(32),
  /**
   * When the export was taken, which is NOT when it was uploaded.
   *
   * The dashboard prints this as how current its figures are. Stamping it with
   * the clock would say a ledger exported last quarter is accurate to this
   * second, which is the same overclaim as serving a cached fixture during an
   * outage and calling it live — the one failure this product has consistently
   * refused. So the reader states it, and a date in the future is refused
   * because a file cannot have been exported tomorrow.
   */
  exportedOn: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/u, "an export date looks like 2026-08-24"),
});

export type LedgerUploadFields = z.infer<typeof LedgerUploadSchema>;

/**
 * Why an upload was refused, as a person needs to hear it.
 *
 * EVERY REASON HAS A SENTENCE, and the type is what makes that true rather than
 * a habit — adding a member to `CsvRefusal` stops this compiling. The reader of
 * these is somebody holding a spreadsheet, so each says what is wrong with the
 * file and, where there is one, what to do about it. The parser's own detail is
 * appended, because "a column has no name" without saying which column is not
 * actionable.
 */
const REFUSAL_SENTENCE: Readonly<Record<CsvRefusal, string>> = {
  too_large: `That file is bigger than the ${String(Math.floor(UPLOAD_MAX_BYTES / (1024 * 1024)))} MB this accepts.`,
  too_many_rows: "That file has more budget lines than this can read.",
  too_many_columns: "That file has more columns than this can read.",
  cell_too_long: "One cell in that file is far longer than a value should be.",
  unclosed_quote:
    "A quoted value in that file is never closed, so everything after it reads as one cell.",
  ragged_row:
    "One row has a different number of cells than the header, so it is not clear which value belongs to which column.",
  empty: "That file has no rows in it.",
  duplicate_header:
    "Two columns share a name, so there is no way to tell which one a value came from.",
  blank_header: "A column in that file has no name.",
  missing_column:
    "That file is missing a column this needs. A ledger export needs line_id, label and budget_per_period, plus one column per period named like 2026-03.",
};

/** The reader-facing sentence for a refusal, with the parser's detail behind it. */
export function refusalMessage(error: CsvRefused): string {
  const detail = error.message.slice(error.message.indexOf(": ") + 2);
  return `${REFUSAL_SENTENCE[error.reason]} (${detail})`;
}

/** What the upload path can refuse before the reader ever sees the file. */
export type UploadRefusal =
  | { readonly kind: "no_file" }
  | { readonly kind: "too_large"; readonly bytes: number }
  | { readonly kind: "not_utf8" }
  | { readonly kind: "fields"; readonly message: string }
  | { readonly kind: "future_export_date" };

export function uploadRefusalMessage(refusal: UploadRefusal): string {
  switch (refusal.kind) {
    case "no_file":
      return "Choose a CSV export to build a dashboard from.";
    case "too_large":
      return `${REFUSAL_SENTENCE.too_large} Yours is ${String(Math.ceil(refusal.bytes / (1024 * 1024)))} MB.`;
    case "not_utf8":
      // Excel on Windows writes CP-1252 unless told otherwise, and its amounts
      // would survive the mis-decode while its labels turned to nonsense. A
      // dashboard with correct figures and mangled names is worse than one that
      // did not build, because only the second is obviously wrong.
      return "That file is not UTF-8 text. Re-export it as CSV UTF-8 and try again.";
    case "fields":
      return refusal.message;
    case "future_export_date":
      return "That export date is in the future. A file cannot have been exported later than today.";
  }
}

/**
 * The parsed fields, or the first thing wrong with them.
 *
 * `exportedOn` is checked against a clock passed in rather than read here, so
 * the boundary case — a file exported today — is testable without waiting for
 * midnight.
 */
export function readUploadFields(
  raw: Record<string, unknown>,
  now: Date,
):
  | { ok: true; fields: LedgerUploadFields }
  | { ok: false; refusal: UploadRefusal } {
  const parsed = LedgerUploadSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      refusal: {
        kind: "fields",
        message: fieldMessage(first?.path[0], first?.message),
      },
    };
  }

  const exportedAt = new Date(`${parsed.data.exportedOn}T00:00:00.000Z`);
  /*
   * Two ways a date can match the pattern and not be a date, and only one of
   * them is obvious.
   *
   * `2026-13-01` and `2026-08-32` are rejected by the parser, which is the easy
   * case. `2026-02-30` is NOT: it parses, silently rolling forward to March 2,
   * so a reader who typed a day February does not have would have got a
   * dashboard stamped with a date they never gave. The round trip is what
   * catches it — a real date renders back as the string it came from, and a
   * rolled-over one does not.
   */
  if (
    Number.isNaN(exportedAt.getTime()) ||
    exportedAt.toISOString().slice(0, 10) !== parsed.data.exportedOn
  ) {
    return {
      ok: false,
      refusal: {
        kind: "fields",
        message: fieldMessage("exportedOn", undefined),
      },
    };
  }
  // Compared against the start of today in UTC, so an export stamped with
  // today's date is accepted anywhere on earth rather than refused by whoever
  // is west of the server.
  const startOfToday = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  if (exportedAt.getTime() > startOfToday) {
    return { ok: false, refusal: { kind: "future_export_date" } };
  }

  return { ok: true, fields: parsed.data };
}

const FIELD_LABEL: Readonly<Record<string, string>> = {
  request: "Say what you want the dashboard to show.",
  sourceName:
    "Name the export, so the dashboard can say where its figures came from.",
  currency: "Give the currency as three letters, e.g. USD.",
  periodLabel: 'Say what one column is — "month", "quarter".',
  exportedOn: "Give the date the export was taken, as 2026-08-24.",
};

function fieldMessage(path: unknown, fallback: string | undefined): string {
  const named = typeof path === "string" ? FIELD_LABEL[path] : undefined;
  return named ?? fallback ?? "Fill in the details about this export.";
}

/** The provenance a snapshot carries, built from what the reader declared. */
export function sourceFromFields(fields: LedgerUploadFields): LedgerSource {
  return LedgerSourceSchema.parse({
    sourceName: fields.sourceName,
    retrievedAt: `${fields.exportedOn}T00:00:00.000Z`,
    currency: fields.currency,
    periodLabel: fields.periodLabel,
  });
}

/**
 * Bytes to snapshot, refusing rather than repairing at every step.
 *
 * The bytes are decoded to text for the reader and are otherwise left alone:
 * what gets stored is what arrived, not what this understood it to be. A file
 * whose meaning we recorded instead of whose content we recorded would be
 * evidence of our own interpretation.
 */
export function snapshotFromUpload(
  bytes: Uint8Array,
  fields: LedgerUploadFields,
): { ok: true; snapshot: LedgerSnapshot } | { ok: false; message: string } {
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
    // `fatal` is the whole point. Without it an invalid byte becomes U+FFFD and
    // the file reads as text that is subtly not what the author wrote.
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, message: uploadRefusalMessage({ kind: "not_utf8" }) };
  }

  try {
    return {
      ok: true,
      snapshot: ledgerFromCsv(text, sourceFromFields(fields)),
    };
  } catch (error) {
    if (error instanceof CsvRefused) {
      return { ok: false, message: refusalMessage(error) };
    }
    if (error instanceof z.ZodError) {
      return { ok: false, message: contractMessage(error) };
    }
    throw error;
  }
}

/**
 * What the snapshot contract refused, said to somebody holding a spreadsheet.
 *
 * WHY THIS IS NOT JUST THE ZOD MESSAGE. The comment this replaced claimed the
 * contract's "messages are written for this and name the row", and that was
 * false for every per-row failure. `amounts are decimal text, e.g. 49875 or
 * 12.50` is a good sentence with the one thing missing that a person needs: a
 * ten-thousand-row export has ten thousand candidates for the cell it means.
 * The row is in the issue's `path`, which the old message discarded.
 *
 * `lines[i]` is the (i + 2)th line of the file, because the header is line 1
 * and `ledgerFromCsv` builds one entry per data row in file order.
 */
function contractMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) {
    return "That export does not read as a ledger. Check the values in it.";
  }

  const path = issue.path;
  // Too few period columns, reported by the contract as an array length. Zod's
  // own wording for it — "Too small: expected array to have >=2 items" — names
  // an internal shape rather than anything in the reader's file.
  if (
    issue.code === "too_small" &&
    (path[0] === "periods" || path.includes("amounts"))
  ) {
    return "That export does not read as a ledger. It needs at least two period columns, named like 2026-03, so a change between periods can be computed.";
  }

  const line =
    path[0] === "lines" && typeof path[1] === "number"
      ? `Row ${String(path[1] + 2)}: `
      : "";
  return `That export does not read as a ledger. ${line}${issue.message}`;
}

/**
 * A filename, reduced to something the evidence record can hold.
 *
 * The client's claim about what the file is called. It is stored as a claim and
 * never used to open, name, or route anything.
 *
 * THE ORDER OF THESE IS LOAD-BEARING, which is not obvious and cost a defect.
 * `source_ref` is CHECKed against `btrim(source_ref)`, so the value may not
 * begin or end with a space. Trimming only BEFORE the cut let the cut put one
 * back: a filename whose 200th character was a space produced a value the
 * constraint rejected, which rolled back the whole upload and surfaced as "that
 * export could not be stored, try again" — advice that could never work, about
 * a cause nothing named. Hence the second trim.
 *
 * A name that survives none of this is replaced rather than the upload being
 * refused, because what a file was called on somebody's laptop is not a reason
 * to reject their ledger.
 */
export function uploadReference(name: string): string {
  const cleaned = name
    .replaceAll(/[\p{Cc}\p{Cf}]/gu, "")
    .trim()
    .slice(0, 200)
    .trim();
  return cleaned === "" ? "uploaded.csv" : cleaned;
}
