// @vitest-environment node
import { describe, expect, it } from "vitest";

import { CSV_LIMITS } from "@dasher/workbook";

import {
  UPLOAD_MAX_BYTES,
  readUploadFields,
  snapshotFromUpload,
  sourceFromFields,
  uploadRefusalMessage,
  type LedgerUploadFields,
} from "./upload";

/**
 * What an uploaded file is allowed to be, and what a person is told when it is
 * not.
 *
 * The refusals are the product here. A file arrives from somebody's laptop, and
 * every way it can be wrong ends with a person looking at a spreadsheet trying
 * to work out what to change — so each of these checks that the sentence they
 * get names the actual problem rather than reporting that something failed.
 */

const FIELDS: LedgerUploadFields = {
  request: "operating spend by category",
  sourceName: "Finance export",
  currency: "USD",
  periodLabel: "month",
  exportedOn: "2026-08-24",
};

const NOW = new Date("2026-08-25T12:00:00.000Z");

const csv = (body: string): string =>
  `line_id,label,budget_per_period,2026-03,2026-04\r\n${body}`;

const bytes = (text: string): Uint8Array =>
  new TextEncoder().encode(text) as Uint8Array;

const raw = (overrides: Partial<Record<string, unknown>> = {}) => ({
  ...FIELDS,
  ...overrides,
});

describe("the limit this shares with the reader", () => {
  it("is the reader's own byte limit", () => {
    // Restated in `upload.ts` rather than imported, so the app does not depend
    // on `@dasher/workbook` to hold one number. This is what stops the two
    // drifting: a file between them would be refused by whichever is smaller,
    // carrying the other one's message.
    expect(UPLOAD_MAX_BYTES).toBe(CSV_LIMITS.maxBytes);
  });
});

describe("the details a file cannot state about itself", () => {
  it("accepts a complete declaration", () => {
    const read = readUploadFields(raw(), NOW);

    expect(read.ok).toBe(true);
  });

  it.each([
    ["request", "Say what you want"],
    ["sourceName", "Name the export"],
    ["currency", "three letters"],
    ["periodLabel", "what one column is"],
    ["exportedOn", "date the export was taken"],
  ])("names %s when it is missing", (field, fragment) => {
    const read = readUploadFields(raw({ [field]: "" }), NOW);

    expect(read.ok).toBe(false);
    expect(read.ok === false && uploadRefusalMessage(read.refusal)).toContain(
      fragment,
    );
  });

  it("upper-cases a currency rather than refusing a lower-case one", () => {
    // "usd" is what somebody types. Refusing it would be pedantry; showing it
    // on the dashboard in lower case would be a different unit than ISO 4217
    // names, so it is normalised.
    const read = readUploadFields(raw({ currency: " usd " }), NOW);

    expect(read.ok === true && read.fields.currency).toBe("USD");
  });

  it("refuses a currency that is not three letters", () => {
    for (const currency of ["US", "USDD", "US1", "$$$"]) {
      expect(readUploadFields(raw({ currency }), NOW).ok).toBe(false);
    }
  });

  /**
   * The export date is the one field that is a claim about time, and the
   * dashboard prints it as how current its figures are. Stamping it from the
   * clock would say a ledger exported last quarter is accurate to this second.
   */
  it("accepts a file exported today", () => {
    // The boundary, and the reason a clock is passed in rather than read: this
    // has to be testable without waiting for midnight.
    expect(readUploadFields(raw({ exportedOn: "2026-08-25" }), NOW).ok).toBe(
      true,
    );
  });

  it("refuses a file exported tomorrow", () => {
    const read = readUploadFields(raw({ exportedOn: "2026-08-26" }), NOW);

    expect(read.ok).toBe(false);
    expect(read.ok === false && uploadRefusalMessage(read.refusal)).toContain(
      "cannot have been exported later than today",
    );
  });

  it("compares against the start of the day in UTC, not the instant", () => {
    // A reader west of the server uploads a file stamped with their today,
    // which is the server's today for another few hours. Comparing instants
    // would refuse it for being "in the future" by a matter of hours.
    const earlyMorning = new Date("2026-08-25T00:30:00.000Z");

    expect(
      readUploadFields(raw({ exportedOn: "2026-08-25" }), earlyMorning).ok,
    ).toBe(true);
  });

  it("carries the declaration onto the snapshot's provenance", () => {
    const source = sourceFromFields(FIELDS);

    expect(source).toStrictEqual({
      sourceName: "Finance export",
      retrievedAt: "2026-08-24T00:00:00.000Z",
      currency: "USD",
      periodLabel: "month",
    });
  });
});

describe("reading the bytes", () => {
  it("builds a snapshot from a file an exporter would write", () => {
    const read = snapshotFromUpload(
      bytes(csv("cloud,Cloud,100,10,20\r\nsalaries,Salaries,,30,40\r\n")),
      FIELDS,
    );

    expect(read.ok).toBe(true);
    expect(read.ok === true && read.snapshot.lines).toStrictEqual([
      {
        id: "cloud",
        label: "Cloud",
        budgetPerPeriod: "100",
        amounts: ["10", "20"],
      },
      { id: "salaries", label: "Salaries", amounts: ["30", "40"] },
    ]);
    // The declared provenance, not anything derived from the file.
    expect(read.ok === true && read.snapshot.currency).toBe("USD");
  });

  it("refuses bytes that are not UTF-8 rather than reading them as nonsense", () => {
    // What Excel on Windows writes without being told otherwise: 0xE9 is "é"
    // in CP-1252 and is not valid UTF-8 at all. Decoded leniently it becomes a
    // replacement character, so the amounts survive and the labels turn to
    // rubbish — a dashboard with correct figures and mangled names, which is
    // worse than one that did not build because only the second is obviously
    // wrong.
    const latin1 = new Uint8Array([
      ...bytes("line_id,label,budget_per_period,2026-03,2026-04\r\ncaf"),
      0xe9,
      ...bytes(",Caf,100,10,20\r\n"),
    ]);

    const read = snapshotFromUpload(latin1, FIELDS);

    expect(read.ok).toBe(false);
    expect(read.ok === false && read.message).toContain("not UTF-8 text");
  });

  it("refuses a file larger than the limit, and says how large it is", () => {
    const large = new Uint8Array(UPLOAD_MAX_BYTES + 1);

    const read = snapshotFromUpload(large, FIELDS);

    expect(read.ok).toBe(false);
    expect(read.ok === false && read.message).toMatch(/bigger than the 4 MB/u);
  });

  /**
   * One sentence per refusal reason, checked by triggering the reason rather
   * than by reading the table back. A message that names the wrong problem
   * sends somebody to look at the wrong part of their file.
   */
  it.each([
    [
      "a missing column",
      "id,label,budget_per_period,2026-03,2026-04\r\nc,C,1,2,3\r\n",
      /needs line_id, label and budget_per_period/u,
    ],
    [
      "no period columns",
      "line_id,label,budget_per_period\r\ncloud,Cloud,100\r\n",
      /one column per period named like 2026-03/u,
    ],
    [
      "a ragged row",
      csv("cloud,Cloud,100,10\r\n"),
      /different number of cells than the header/u,
    ],
    [
      "two columns with one name",
      "line_id,label,budget_per_period,2026-03,2026-03\r\nc,C,1,2,3\r\n",
      /Two columns share a name/u,
    ],
    [
      "an unnamed column",
      "line_id,label,budget_per_period,,2026-04\r\nc,C,1,2,3\r\n",
      /has no name/u,
    ],
    ["an empty file", "", /no rows in it/u],
    [
      "a quote that is never closed",
      csv('cloud,"Cloud,100,10,20\r\n'),
      /never closed/u,
    ],
  ])("says what is wrong with %s", (_name, text, expected) => {
    const read = snapshotFromUpload(bytes(text), FIELDS);

    expect(read.ok).toBe(false);
    expect(read.ok === false && read.message).toMatch(expected);
  });

  it("appends the reader's own detail, so the message names the column", () => {
    const read = snapshotFromUpload(
      bytes("line_id,label,budget_per_period,,2026-04\r\nc,C,1,2,3\r\n"),
      FIELDS,
    );

    // "A column has no name" without saying which one is not actionable.
    expect(read.ok === false && read.message).toContain("column 4");
  });

  it("refuses a ledger the contract will not accept, and quotes the contract", () => {
    // Not a malformed file — this one parses. A blank amount is a hole in the
    // table, and the snapshot schema is what refuses it.
    const read = snapshotFromUpload(
      bytes(csv("cloud,Cloud,100,,20\r\n")),
      FIELDS,
    );

    expect(read.ok).toBe(false);
    expect(read.ok === false && read.message).toMatch(
      /does not read as a ledger/u,
    );
    expect(read.ok === false && read.message).toMatch(/decimal text/u);
  });

  it("refuses periods that run newest first rather than reordering them", () => {
    const reversed =
      "line_id,label,budget_per_period,2026-04,2026-03\r\ncloud,Cloud,100,20,10\r\n";

    const read = snapshotFromUpload(bytes(reversed), FIELDS);

    expect(read.ok).toBe(false);
    expect(read.ok === false && read.message).toMatch(/oldest first/u);
  });

  it("keeps the cents exactly as the file wrote them", () => {
    const read = snapshotFromUpload(
      bytes(csv("cloud,Cloud,100.00,49875.00,0.10\r\n")),
      FIELDS,
    );

    expect(read.ok === true && read.snapshot.lines[0]?.amounts).toStrictEqual([
      "49875.00",
      "0.10",
    ]);
  });
});

/**
 * What tracing this file's mutation survivors found.
 *
 * Every one of these was a test that stopped one character short of the thing
 * it was checking: a message asserted by a fragment rather than in full, a
 * limit whose refusal was indistinguishable from the reader's own, a date
 * branch nothing reached. Two were real defects rather than weak assertions.
 */
describe("the parts a fragment of a message did not check", () => {
  it("refuses a date that matches the pattern and is not a date", () => {
    // The parser's own answer to a thirteenth month or a thirty-second day.
    for (const exportedOn of ["2026-13-01", "2026-08-32", "0000-00-00"]) {
      const read = readUploadFields(raw({ exportedOn }), NOW);

      expect(read.ok).toBe(false);
      expect(read.ok === false && uploadRefusalMessage(read.refusal)).toContain(
        "date the export was taken",
      );
    }
  });

  it("refuses a day the month does not have, rather than rolling it forward", () => {
    // THE DEFECT THIS FOUND. `2026-02-30` parses: it rolls silently to March 2.
    // A reader who typed a day February does not have was getting a dashboard
    // stamped with a date they never gave, and the field the dashboard prints
    // as "how current is this" was the one being changed underneath them.
    const read = readUploadFields(raw({ exportedOn: "2026-02-30" }), NOW);

    expect(read.ok).toBe(false);
  });

  it("keeps a real end-of-month date, which is the same shape", () => {
    // The counterweight: the check above must not refuse the 29th of a leap
    // February or the 31st of a month that has one.
    expect(readUploadFields(raw({ exportedOn: "2024-02-29" }), NOW).ok).toBe(
      true,
    );
    expect(readUploadFields(raw({ exportedOn: "2026-01-31" }), NOW).ok).toBe(
      true,
    );
    expect(readUploadFields(raw({ exportedOn: "2026-02-29" }), NOW).ok).toBe(
      false,
    );
  });

  it("says how large the file actually is, not only that it is too large", () => {
    // Asserted in full, because the fragment "bigger than the 4 MB" is also
    // what the CSV reader's own size refusal produces — both share the
    // sentence. Removing this file's check entirely left that fragment intact,
    // so the check could have been deleted without a test noticing.
    const read = snapshotFromUpload(
      new Uint8Array(UPLOAD_MAX_BYTES + 1),
      FIELDS,
    );

    expect(read.ok === false && read.message).toBe(
      "That file is bigger than the 4 MB this accepts. Yours is 5 MB.",
    );
  });

  it("puts the reader's sentence and the parser's detail in one message", () => {
    // In full, for the same reason. Checking that it contains "column 4" left
    // the slice that extracts the detail free to start two characters early or
    // late, or to hand back the whole of the parser's message including the
    // reason code the reader has no use for.
    const read = snapshotFromUpload(
      bytes("line_id,label,budget_per_period,,2026-04\r\nc,C,1,2,3\r\n"),
      FIELDS,
    );

    expect(read.ok === false && read.message).toBe(
      "A column in that file has no name. (column 4 has no name)",
    );
  });

  it("has a sentence for the refusals no file ever produces", () => {
    // `no_file` and `too_large` are decided in the action, before this file
    // sees any bytes, so nothing here reaches them through a file. They are
    // still this file's sentences, and an empty one would be shown to a person.
    expect(uploadRefusalMessage({ kind: "no_file" })).toBe(
      "Choose a CSV export to build a dashboard from.",
    );
    expect(
      uploadRefusalMessage({ kind: "too_large", bytes: 6 * 1024 * 1024 }),
    ).toBe("That file is bigger than the 4 MB this accepts. Yours is 6 MB.");
  });
});

/**
 * The one survivor that was reachable, and a note on the seven that are not.
 *
 * WHAT REMAINS UNKILLED, AND WHY IT IS LEFT. Seven mutants survive this file
 * and each one weakens a guard that cannot fire:
 *
 *   - `first?.path` and `first?.message` — a Zod failure always carries at
 *     least one issue, so `issues[0]` is never absent. The optional chaining is
 *     there because the index signature says it might be, not because it can.
 *   - `typeof path === "string"` in `fieldMessage`, and the last `??` after it.
 *     A strict schema does report an unrecognized key with an EMPTY path, so
 *     the guard is reached with `undefined` — but `FIELD_LABEL[undefined]` is
 *     `undefined` too, so removing the guard changes nothing any input can
 *     observe. It narrows a type; it does not decide anything. Tested below for
 *     the behaviour that IS observable, which is that such a complaint still
 *     produces a sentence.
 *   - the `instanceof ZodError` check becoming `true`, and its message
 *     fallback — `ledgerFromCsv` throws a `CsvRefused` or a `ZodError` and
 *     nothing else, so the branch that re-raises anything unexpected guards
 *     against a future third kind rather than a path that exists today.
 *
 * Writing tests that reach those would mean constructing errors this code
 * cannot receive, or asserting a difference no input produces. Recorded here
 * instead, so the next reader knows they were traced rather than tolerated.
 */
describe("the survivors that were reachable after all", () => {
  it("still produces a sentence when the complaint names no field", () => {
    // `readUploadFields` takes a bag of unknowns, and a strict schema reports an
    // unexpected key with an empty path — so the branch that reads the field
    // name gets nothing to read. It has to say something anyway.
    const read = readUploadFields(raw({ colour: "blue" }), NOW);

    expect(read.ok).toBe(false);
    expect(read.ok === false && uploadRefusalMessage(read.refusal)).not.toBe(
      "",
    );
  });

  it("accepts a file of exactly the limit", () => {
    // The boundary, which "a file one byte over is refused" never reaches — the
    // comparison survived being weakened from `>` to `>=`, meaning a file of
    // exactly 4 MB could have been refused for its size without a test
    // noticing. Past the size check it is refused for what it actually is.
    //
    // The first byte is invalid UTF-8 so the decode fails immediately. A buffer
    // of nulls is valid text and walks the whole four megabytes through the CSV
    // reader — fast enough in an ordinary run, and over the timeout under
    // mutation instrumentation, which is how this shape was arrived at.
    const atTheLimit = new Uint8Array(UPLOAD_MAX_BYTES);
    atTheLimit[0] = 0xff;

    const read = snapshotFromUpload(atTheLimit, FIELDS);

    expect(read.ok).toBe(false);
    expect(read.ok === false && read.message).not.toMatch(/bigger than/u);
    expect(read.ok === false && read.message).toMatch(/not UTF-8 text/u);
  });
});
