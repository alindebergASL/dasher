import { readFileSync } from "node:fs";
import path from "node:path";
import { deflateRawSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { looksLikeZip, ZipArchive, ZipError } from "./zip";

const FIXTURE = path.resolve(
  process.cwd(),
  "..",
  "..",
  "fixtures",
  "xlsx",
  "transactions.xlsx",
);

/**
 * The archive under test was written by Python's openpyxl, not by this code, so
 * these check the reader against a file a real writer produced rather than
 * against its own idea of a ZIP.
 */
describe("reading a real spreadsheet archive", () => {
  const bytes = new Uint8Array(readFileSync(FIXTURE));

  it("lists the parts a spreadsheet is made of", () => {
    const archive = new ZipArchive(bytes);
    expect(archive.names()).toEqual(
      expect.arrayContaining([
        "[Content_Types].xml",
        "xl/workbook.xml",
        "xl/worksheets/sheet1.xml",
        "xl/styles.xml",
      ]),
    );
    expect(archive.has("xl/worksheets/sheet1.xml")).toBe(true);
    expect(archive.has("xl/sharedStrings.xml")).toBe(false);
  });

  it("inflates a deflated part back to well-formed XML", () => {
    const sheet = new ZipArchive(bytes).text("xl/worksheets/sheet1.xml");
    expect(sheet.startsWith("<worksheet")).toBe(true);
    expect(sheet.trimEnd().endsWith("</worksheet>")).toBe(true);
    // The date cell openpyxl wrote: serial 46083 is 2026-03-02.
    expect(sheet).toContain("<v>46083</v>");
  });

  it("names the part it cannot find rather than returning nothing", () => {
    const archive = new ZipArchive(bytes);
    expect(() => archive.read("xl/sharedStrings.xml")).toThrow(ZipError);
    expect(() => archive.read("xl/sharedStrings.xml")).toThrow(
      /no xl\/sharedStrings\.xml/u,
    );
  });

  it("recognises an archive by its header, not its name", () => {
    expect(looksLikeZip(bytes)).toBe(true);
    expect(looksLikeZip(new TextEncoder().encode("Date,Category\n"))).toBe(
      false,
    );
    expect(looksLikeZip(new Uint8Array([0x50, 0x4b]))).toBe(false);
  });
});

/** A hand-built archive, so both storage methods are exercised deliberately. */
function archiveOf(
  files: readonly { name: string; body: string; store?: boolean }[],
): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const nameBytes = new TextEncoder().encode(file.name);
    const raw = new TextEncoder().encode(file.body);
    const body =
      file.store === true ? raw : new Uint8Array(deflateRawSync(raw));
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(8, file.store === true ? 0 : 8, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, raw.length, true);
    local.setUint16(26, nameBytes.length, true);
    parts.push(new Uint8Array(local.buffer), nameBytes, body);

    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(10, file.store === true ? 0 : 8, true);
    entry.setUint32(20, body.length, true);
    entry.setUint32(24, raw.length, true);
    entry.setUint16(28, nameBytes.length, true);
    entry.setUint32(42, offset, true);
    central.push(new Uint8Array(entry.buffer), nameBytes);
    offset += 30 + nameBytes.length + body.length;
  }
  const centralBytes = central.reduce<number[]>(
    (all, part) => [...all, ...part],
    [],
  );
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralBytes.length, true);
  end.setUint32(16, offset, true);
  const all = [
    ...parts.reduce<number[]>((acc, part) => [...acc, ...part], []),
    ...centralBytes,
    ...new Uint8Array(end.buffer),
  ];
  return new Uint8Array(all);
}

describe("archives this reader must still handle", () => {
  it("reads an uncompressed part as well as a deflated one", () => {
    const archive = new ZipArchive(
      archiveOf([
        { name: "stored.xml", body: "<a>kept whole</a>", store: true },
        { name: "deflated.xml", body: "<b>squeezed</b>" },
      ]),
    );
    expect(archive.text("stored.xml")).toBe("<a>kept whole</a>");
    expect(archive.text("deflated.xml")).toBe("<b>squeezed</b>");
  });

  it("refuses a file that is not an archive at all", () => {
    expect(
      () =>
        new ZipArchive(
          new TextEncoder().encode(
            "Date,Category,Amount\n2026-03-02,Cloud,1234.56\n2026-03-17,Travel,890.10\n",
          ),
        ),
    ).toThrow(/not a readable spreadsheet archive/u);
  });

  it("refuses an empty file rather than reading past its end", () => {
    expect(() => new ZipArchive(new Uint8Array(0))).toThrow(/too short/u);
  });
});
