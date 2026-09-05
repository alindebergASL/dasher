// @vitest-environment node
import { describe, expect, it } from "vitest";

import { readUpload, UPLOAD_MAX_BYTES, uploadRefusalMessage } from "./upload";

const encoder = new TextEncoder();

describe("readUpload", () => {
  it("reads a transactions export into a typed table", () => {
    const read = readUpload(
      "spend.csv",
      encoder.encode(
        'Date,Description,Category,Amount\n2026-01-03,Datadog,Cloud,"$1,234.50"\n2026-02-03,Refund,Cloud,(45.00)\n',
      ),
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.upload.name).toBe("spend.csv");
    expect(read.upload.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(read.upload.table.rowCount).toBe(2);
    expect(
      read.upload.table.columns.find((column) => column.name === "Amount")
        ?.type,
    ).toBe("number");
  });

  it("refuses an empty file", () => {
    const read = readUpload("empty.csv", new Uint8Array());
    expect(read).toEqual({
      ok: false,
      message: uploadRefusalMessage({ kind: "no_file" }),
    });
  });

  it("refuses a file over the byte limit before decoding it", () => {
    const read = readUpload("big.csv", new Uint8Array(UPLOAD_MAX_BYTES + 1));
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.message).toMatch(/bigger than/u);
  });

  it("refuses bytes that are not UTF-8", () => {
    const read = readUpload("latin1.csv", new Uint8Array([0x41, 0xff, 0xfe]));
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.message).toMatch(/UTF-8/u);
  });

  it("refuses text that is not a table, and says why", () => {
    const read = readUpload(
      "notes.csv",
      encoder.encode("just a sentence with no header or rows"),
    );
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.message).toMatch(/could not be read/u);
  });
});
