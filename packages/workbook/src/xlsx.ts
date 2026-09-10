/**
 * Reading a spreadsheet into the same rows a CSV produces.
 *
 * Every cell leaves here as text, and nothing downstream can tell where it came
 * from. That is the point: amounts, dates, currencies and locale conventions
 * are then decided by exactly the code a CSV goes through, so a spreadsheet
 * cannot acquire a second, less careful arithmetic on the way in.
 *
 * Two things in this format put wrong numbers on screen if taken casually:
 *
 * - A number is stored as a decimal string. Parsing it into a JavaScript number
 *   and printing it back is what turns 0.1 + 0.2 into 0.30000000000000004, so
 *   the stored characters are carried through untouched.
 * - A date is a plain number that means a date only because its cell's format
 *   says so. Lotus 1-2-3 wrongly treated 1900 as a leap year, Excel copied it
 *   for compatibility, and every serial after 28 February 1900 still carries
 *   that phantom day.
 */
import { ZipArchive, ZipError, looksLikeZip } from "./zip";

export class SpreadsheetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpreadsheetError";
  }
}

/** Built-in formats that mean a date or a time; the rest are looked at. */
const BUILT_IN_DATE_FORMATS = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47,
]);

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/giu, (whole, body: string) => {
    const named = ENTITIES[body.toLowerCase()];
    if (named !== undefined) return named;
    if (body.startsWith("#")) {
      const code =
        body.startsWith("#x") || body.startsWith("#X")
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      if (Number.isInteger(code) && code >= 0 && code <= 0x10ffff) {
        return String.fromCodePoint(code);
      }
    }
    return whole;
  });
}

/** One attribute of an element, without parsing the whole document. */
function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`, "u").exec(tag);
  return match === null ? undefined : decodeEntities(match[1] as string);
}

/** Every occurrence of an element, as [openingTag, innerText]. */
function* elements(
  xml: string,
  name: string,
): Generator<{ tag: string; inner: string }> {
  const opening = new RegExp(`<${name}(\\s[^>]*?)?(/?)>`, "gu");
  let match: RegExpExecArray | null;
  while ((match = opening.exec(xml)) !== null) {
    const tag = match[0];
    if (match[2] === "/") {
      yield { tag, inner: "" };
      continue;
    }
    const closing = `</${name}>`;
    const end = xml.indexOf(closing, opening.lastIndex);
    if (end === -1) return;
    yield { tag, inner: xml.slice(opening.lastIndex, end) };
    opening.lastIndex = end + closing.length;
  }
}

/** The text of every `<t>` in a fragment, joined: a run-formatted cell is one string. */
function joinText(xml: string): string {
  let text = "";
  for (const run of elements(xml, "t")) text += decodeEntities(run.inner);
  return text;
}

function sharedStrings(archive: ZipArchive): string[] {
  if (!archive.has("xl/sharedStrings.xml")) return [];
  const xml = archive.text("xl/sharedStrings.xml");
  return [...elements(xml, "si")].map((item) => joinText(item.inner));
}

/**
 * Which style indexes mean a date. A cell's `s` points into `cellXfs`, whose
 * entry names a number format; that format is a date if it is one of the
 * built-in date ones or its code contains a date or time placeholder.
 */
function dateStyles(archive: ZipArchive): Set<number> {
  const dated = new Set<number>();
  if (!archive.has("xl/styles.xml")) return dated;
  const xml = archive.text("xl/styles.xml");

  const custom = new Map<number, string>();
  for (const format of elements(xml, "numFmt")) {
    const id = Number(attribute(format.tag, "numFmtId"));
    const code = attribute(format.tag, "formatCode");
    if (Number.isInteger(id) && code !== undefined) custom.set(id, code);
  }

  const cellXfs = [...elements(xml, "cellXfs")][0];
  if (cellXfs === undefined) return dated;
  let index = 0;
  for (const xf of elements(cellXfs.inner, "xf")) {
    const id = Number(attribute(xf.tag, "numFmtId") ?? "0");
    const code = custom.get(id);
    const isDate =
      BUILT_IN_DATE_FORMATS.has(id) ||
      (code !== undefined && looksLikeDateFormat(code));
    if (isDate) dated.add(index);
    index += 1;
  }
  return dated;
}

/**
 * A format code means a date if a date or time placeholder survives once the
 * parts that only look like one are removed: quoted literals, escaped
 * characters, bracketed conditions and colours, and the "General" keyword.
 */
export function looksLikeDateFormat(code: string): boolean {
  const bare = code
    .replace(/"[^"]*"/gu, "")
    .replace(/\\./gu, "")
    .replace(/\[[^\]]*\]/gu, "")
    .replace(/general/giu, "");
  return /[ymdhs]/iu.test(bare);
}

/**
 * The calendar date a serial number names, as `YYYY-MM-DD`.
 *
 * Day 1 is 1 January 1900, but Excel also believes in 29 February 1900, which
 * never happened. Serials at or below 59 are therefore counted from 31
 * December 1899 and later ones from 30 December 1899, which lands both sides of
 * the phantom day on the dates a spreadsheet displays. Serial 60 is that
 * phantom itself and names no real date.
 */
export function serialToIsoDate(
  serial: number,
  epoch1904: boolean,
): string | undefined {
  if (!Number.isFinite(serial) || serial < 0) return undefined;
  const days = Math.floor(serial);
  if (epoch1904) {
    return isoFrom(Date.UTC(1904, 0, 1) + days * 86_400_000);
  }
  if (days === 60) return undefined;
  if (days === 0) return undefined;
  const anchor = days < 60 ? Date.UTC(1899, 11, 31) : Date.UTC(1899, 11, 30);
  return isoFrom(anchor + days * 86_400_000);
}

function isoFrom(milliseconds: number): string | undefined {
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime())
    ? undefined
    : date.toISOString().slice(0, 10);
}

/** `B12` → 1. Only the letters matter; the row number is carried by `<row>`. */
export function columnOf(reference: string): number | undefined {
  const letters = /^([A-Z]+)/u.exec(reference.toUpperCase());
  if (letters === null) return undefined;
  let column = 0;
  for (const letter of letters[1] as string) {
    column = column * 26 + (letter.charCodeAt(0) - 64);
  }
  return column - 1;
}

interface SheetRef {
  readonly name: string;
  readonly path: string;
}

/** The sheets in tab order, resolved to the parts that hold them. */
function sheetRefs(archive: ZipArchive): SheetRef[] {
  const book = archive.text("xl/workbook.xml");
  const targets = new Map<string, string>();
  if (archive.has("xl/_rels/workbook.xml.rels")) {
    const rels = archive.text("xl/_rels/workbook.xml.rels");
    for (const rel of elements(rels, "Relationship")) {
      const id = attribute(rel.tag, "Id");
      const target = attribute(rel.tag, "Target");
      if (id !== undefined && target !== undefined) targets.set(id, target);
    }
  }
  const refs: SheetRef[] = [];
  let fallback = 0;
  for (const sheet of elements(book, "sheet")) {
    fallback += 1;
    // A hidden sheet is one the author put away; reading it would surprise them.
    const state = attribute(sheet.tag, "state");
    if (state === "hidden" || state === "veryHidden") continue;
    const id = attribute(sheet.tag, "r:id") ?? attribute(sheet.tag, "id");
    const target = id === undefined ? undefined : targets.get(id);
    const path =
      target === undefined
        ? `xl/worksheets/sheet${String(fallback)}.xml`
        : normalise(target);
    refs.push({
      name: attribute(sheet.tag, "name") ?? `Sheet${String(fallback)}`,
      path,
    });
  }
  return refs;
}

/** Relationship targets are relative to `xl/`, and may point up out of it. */
function normalise(target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = `xl/${target}`.split("/");
  const kept: string[] = [];
  for (const part of parts) {
    if (part === "." || part === "") continue;
    if (part === "..") kept.pop();
    else kept.push(part);
  }
  return kept.join("/");
}

function readSheet(
  xml: string,
  strings: readonly string[],
  dated: ReadonlySet<number>,
  epoch1904: boolean,
): string[][] {
  const rows: string[][] = [];
  for (const row of elements(xml, "row")) {
    const cells: string[] = [];
    for (const cell of elements(row.inner, "c")) {
      const reference = attribute(cell.tag, "r");
      const at =
        reference === undefined
          ? cells.length
          : (columnOf(reference) ?? cells.length);
      // Skipped columns are empty cells, not absent ones: a row that jumps
      // from A to C has a blank B, and dropping it would shift every value
      // after it into the wrong column.
      while (cells.length < at) cells.push("");
      cells[at] = cellText(cell, strings, dated, epoch1904);
    }
    const number = Number(attribute(row.tag, "r"));
    const at =
      Number.isInteger(number) && number > 0 ? number - 1 : rows.length;
    while (rows.length < at) rows.push([]);
    rows[at] = cells;
  }
  return rows;
}

function cellText(
  cell: { tag: string; inner: string },
  strings: readonly string[],
  dated: ReadonlySet<number>,
  epoch1904: boolean,
): string {
  const type = attribute(cell.tag, "t") ?? "n";
  if (type === "inlineStr") return joinText(cell.inner);

  const value = [...elements(cell.inner, "v")][0];
  // A formula cell with no cached value has never been calculated; there is
  // no figure to read and inventing one would be worse than a blank.
  if (value === undefined) return "";
  const raw = decodeEntities(value.inner).trim();

  switch (type) {
    case "s": {
      const index = Number(raw);
      return Number.isInteger(index) ? (strings[index] ?? "") : "";
    }
    case "str":
      return decodeEntities(raw);
    case "b":
      return raw === "1" ? "TRUE" : "FALSE";
    case "e":
      // #DIV/0!, #N/A and friends are the absence of a value, and the pipeline
      // already refuses a period whose amounts it cannot read.
      return "";
    default:
      break;
  }

  const style = Number(attribute(cell.tag, "s") ?? "");
  if (Number.isInteger(style) && dated.has(style)) {
    const iso = serialToIsoDate(Number(raw), epoch1904);
    if (iso !== undefined) return iso;
  }
  // Carried verbatim: these characters are the number, and re-printing a
  // parsed float is how exact amounts stop being exact.
  return raw;
}

export interface Spreadsheet {
  readonly sheetName: string;
  readonly rows: readonly (readonly string[])[];
  /** Names of every sheet read past to reach the one used, in tab order. */
  readonly skipped: readonly string[];
}

/**
 * The first sheet that holds more than one row, as rows of text.
 *
 * A workbook's first tab is often a cover note or a chart; the first sheet with
 * a header and at least one row under it is the one someone meant to share.
 */
export function readSpreadsheet(bytes: Uint8Array): Spreadsheet {
  let archive: ZipArchive;
  try {
    archive = new ZipArchive(bytes);
  } catch (error) {
    throw new SpreadsheetError(
      error instanceof ZipError
        ? error.message
        : "This spreadsheet could not be opened.",
    );
  }
  if (!archive.has("xl/workbook.xml")) {
    throw new SpreadsheetError(
      "This file is a zip archive but not a spreadsheet.",
    );
  }
  const epoch1904 = /date1904\s*=\s*"(1|true)"/iu.test(
    archive.text("xl/workbook.xml"),
  );
  const strings = sharedStrings(archive);
  const dated = dateStyles(archive);

  const skipped: string[] = [];
  for (const ref of sheetRefs(archive)) {
    if (!archive.has(ref.path)) {
      skipped.push(ref.name);
      continue;
    }
    const rows = readSheet(archive.text(ref.path), strings, dated, epoch1904);
    const filled = rows.filter((row) => row.some((cell) => cell !== ""));
    if (filled.length >= 2) {
      return { sheetName: ref.name, rows, skipped };
    }
    skipped.push(ref.name);
  }
  throw new SpreadsheetError(
    skipped.length === 0
      ? "This spreadsheet has no sheets."
      : `No sheet in this spreadsheet has a header and rows under it (looked at ${skipped.join(", ")}).`,
  );
}

export { looksLikeZip };
