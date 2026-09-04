import { createHash } from "node:crypto";

import { readTable, TableRefused, type Table } from "@dasher/workbook";

import { UPLOAD_MAX_BYTES } from "./planning";

export { UPLOAD_MAX_BYTES };

/**
 * Rows the reader may end up with, which is not the same as rows in the file.
 * A wide export is unpivoted to one row per line and period, so a legal 4 MB
 * file with many period columns multiplies out. Bounding the input alone left
 * a 4 MB upload expanding to millions of rows on the request thread.
 */
export const MAX_TABLE_ROWS = 200_000;

export type UploadRefusal =
  | { readonly kind: "no_file" }
  | { readonly kind: "too_large"; readonly bytes: number }
  | { readonly kind: "not_utf8" }
  | { readonly kind: "too_many_rows"; readonly rows: number }
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
    case "unreadable":
      return `That file could not be read as a table. ${refusal.detail}`;
  }
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
