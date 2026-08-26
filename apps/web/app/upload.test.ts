// @vitest-environment node
import { describe, expect, it } from "vitest";

import { CSV_LIMITS } from "@dasher/workbook";

import {
  UPLOAD_MAX_BYTES,
  readUploadFields,
  snapshotFromUpload,
  sourceFromFields,
  uploadReference,
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
      // The PRODUCT's sentence, not the parser's detail. `/never closed/`
      // matched the parenthesised detail csv.ts appends, so this row passed
      // while `REFUSAL_SENTENCE.unclosed_quote` — the thing the block above
      // calls "the product here" — was asserted by nothing at all.
      /A quoted value in that file is never closed/u,
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
 * The one survivor that was reachable, and a note on the rest.
 *
 * WHAT REMAINS UNKILLED, AND WHY IT IS LEFT. Each surviving mutant weakens a
 * guard that cannot fire, with one exception noted at the end:
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
 *   - the `instanceof ZodError` check becoming `true` — `ledgerFromCsv` throws
 *     a `CsvRefused` or a `ZodError` and nothing else, so the branch that
 *     re-raises anything unexpected guards against a future third kind rather
 *     than a path that exists today.
 *   - `contractMessage`'s `issue === undefined` branch and its sentence. A
 *     `ZodError` always carries at least one issue; the branch exists because
 *     the index signature says it might not.
 *   - `path.includes("amounts")` becoming `""`. Too few period columns is
 *     reported by the contract as `periods` first and `lines[i].amounts`
 *     after, so the first clause always decides and the second is a guard
 *     against an ordering nobody promised.
 *
 * ONE REPORT THAT IS WRONG. Stryker also lists the `path[0] === "lines" &&
 * typeof path[1] === "number"` condition as surviving. It does not: replacing
 * it with `true` by hand turns "says nothing about a row when the fault is the
 * whole file" red, because duplicate ids carry no row index and the message
 * becomes "Row NaN". The tool's per-test coverage attributed the mutant to a
 * subset that excludes that case. Recorded rather than chased, because the
 * behaviour is pinned and re-running the tool would not change what is true.
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

/**
 * The three refusal sentences that no test reached.
 *
 * `upload.test.ts` opens by claiming "one sentence per refusal reason, checked
 * by triggering the reason rather than by reading the table back". That was
 * true of seven of the ten. `too_many_rows`, `too_many_columns` and
 * `cell_too_long` were triggered by nothing, so each could be emptied — or say
 * the wrong thing entirely — without a failure.
 *
 * They need a file at the SHIPPING limits rather than a small injected one,
 * because `snapshotFromUpload` reads through `ledgerFromCsv`, which uses the
 * parser's defaults and takes no limits of its own. Each is built to be just
 * past its limit and no larger.
 */
describe("the refusal sentences that only a real limit reaches", () => {
  const header = "line_id,label,budget_per_period,2026-03,2026-04";

  it("says a file has more budget lines than it can read", () => {
    // Past `maxRows` (10,000) with non-blank records, so this is the stated row
    // limit rather than the record ceiling beside it.
    const rows = Array.from(
      { length: CSV_LIMITS.maxRows + 5 },
      (_unused, index) => `line-${String(index)},L,1,2,3`,
    );
    const read = snapshotFromUpload(
      bytes(`${header}\r\n${rows.join("\r\n")}\r\n`),
      FIELDS,
    );

    expect(read.ok === false && read.message).toBe(
      "That file has more budget lines than this can read. (more than 10000 rows)",
    );
  });

  it("says a file has more columns than it can read", () => {
    const wide = Array.from(
      { length: CSV_LIMITS.maxColumns + 1 },
      (_unused, index) => `c${String(index)}`,
    ).join(",");
    const read = snapshotFromUpload(bytes(`${wide}\r\n`), FIELDS);

    expect(read.ok === false && read.message).toBe(
      "That file has more columns than this can read. (513 columns exceeds 512)",
    );
  });

  it("says one cell is far longer than a value should be", () => {
    const huge = "x".repeat(CSV_LIMITS.maxCellLength + 1);
    const read = snapshotFromUpload(
      bytes(`${header}\r\ncloud,${huge},100,10,20\r\n`),
      FIELDS,
    );

    expect(read.ok === false && read.message).toBe(
      "One cell in that file is far longer than a value should be. (a cell of 4097 characters exceeds 4096)",
    );
  });
});

/**
 * A refusal has to say WHERE, not only what.
 *
 * The contract's own wording is good — "amounts are decimal text, e.g. 49875 or
 * 12.50" — and useless on its own to somebody holding a ten-thousand-row
 * export. The row is in the Zod issue's path, and the message that shipped
 * discarded it while a comment two lines above claimed the opposite.
 */
describe("a bad cell is locatable", () => {
  const header = "line_id,label,budget_per_period,2026-03,2026-04\r\n";

  it.each([
    ["a blank amount", `${header}a,A,1,2,3\r\nb,B,1,,3\r\n`, "Row 3"],
    ["a word where an amount goes", `${header}a,A,1,oops,3\r\n`, "Row 2"],
    [
      "a line id that is not kebab-case",
      `${header}a,A,1,2,3\r\nb,B,1,2,3\r\nCloud X,C,1,2,3\r\n`,
      "Row 4",
    ],
  ])("names the file row for %s", (_name, text, where) => {
    const read = snapshotFromUpload(bytes(text), FIELDS);

    expect(read.ok).toBe(false);
    expect(read.ok === false && read.message).toContain(where);
  });

  it("does not leak the contract's internal wording for too few periods", () => {
    // Zod says "Too small: expected array to have >=2 items", which names a
    // shape inside this program rather than anything in the reader's file.
    const read = snapshotFromUpload(
      bytes("line_id,label,budget_per_period,2026-03\r\na,A,1,2\r\n"),
      FIELDS,
    );

    expect(read.ok === false && read.message).toBe(
      "That export does not read as a ledger. It needs at least two period columns, named like 2026-03, so a change between periods can be computed.",
    );
  });

  it("does not blame the period columns for a fault that is not theirs", () => {
    // A blank label is reported by the contract the same way too few periods
    // are — as a length — so a branch that routes every length complaint to the
    // periods sentence would tell somebody with a missing label to go and add
    // columns. The row is what they need.
    const read = snapshotFromUpload(
      bytes(`${header}a,A,1,2,3\r\nb,,1,2,3\r\n`),
      FIELDS,
    );

    expect(read.ok).toBe(false);
    expect(read.ok === false && read.message).toContain("Row 3");
    expect(read.ok === false && read.message).not.toContain("period columns");
  });

  it("says nothing about a row when the fault is the whole file", () => {
    // Duplicate ids are a property of the set, not of one line, and the
    // contract reports them with no row index. Inventing one would be worse
    // than omitting it.
    const read = snapshotFromUpload(
      bytes(`${header}a,A,1,2,3\r\na,B,1,2,3\r\n`),
      FIELDS,
    );

    expect(read.ok === false && read.message).toBe(
      "That export does not read as a ledger. line ids must be unique",
    );
  });
});

/**
 * The filename, and the constraint on the far side of it.
 *
 * `source_snapshots.source_ref` is `varchar(512)` CHECKed against
 * `source_ref = btrim(source_ref)` and against containing no control
 * characters. Everything here is about producing a value that satisfies all
 * three for any name an operating system will hand over, because failing the
 * constraint does not refuse the upload politely — it aborts the transaction
 * the snapshot and the dashboard share, and the reader is told to try again.
 *
 * The trailing-space case is the one that shipped broken. It was found by
 * running the real function's output at the real constraint, not by reading
 * either.
 */
describe("uploadReference", () => {
  const SPACE = String.fromCharCode(32);
  const btrimStable = (value: string) =>
    value === value.replace(/^ +| +$/gu, "");

  it("keeps an ordinary filename as it is", () => {
    expect(uploadReference("q4-operating-ledger.csv")).toBe(
      "q4-operating-ledger.csv",
    );
  });

  it("never ends in a space, wherever the 200-character cut lands", () => {
    // THE DEFECT. `.trim()` ran before `.slice(200)`, so a name whose 200th
    // character was a space came back with the space on the end and failed
    // `btrim(source_ref) = source_ref`.
    const onTheCut = "a".repeat(199) + SPACE + "b".repeat(60) + ".csv";
    const spanningTheCut = "a".repeat(195) + SPACE.repeat(20) + "b.csv";

    for (const name of [onTheCut, spanningTheCut]) {
      const ref = uploadReference(name);

      expect(ref.length).toBeLessThanOrEqual(200);
      expect(btrimStable(ref)).toBe(true);
    }
  });

  it("holds every name to the column's rules", () => {
    const names = [
      "budget.csv",
      "a".repeat(600),
      SPACE.repeat(10),
      "  padded  .csv",
      "Finance export for the quarter ".repeat(9) + "final.csv",
      "réservé — budget 2026.csv",
      "\u0007\u0008ring.csv",
      "",
    ];

    for (const name of names) {
      const ref = uploadReference(name);

      expect(ref.length).toBeGreaterThanOrEqual(1);
      expect(ref.length).toBeLessThanOrEqual(512);
      expect(btrimStable(ref)).toBe(true);
      // The CHECK also forbids control characters.
      expect(/\p{Cc}/u.test(ref)).toBe(false);
    }
  });

  it("keeps the real characters of a name that is mostly padding", () => {
    // Both trims earn their place. The FIRST one decides which 200 characters
    // the cut keeps: without it, a name padded with 300 leading spaces would
    // cut to 200 spaces and collapse to the fallback, throwing away a perfectly
    // good filename. The SECOND is what guarantees the value the column will
    // accept.
    const padded = SPACE.repeat(300) + "quarterly-budget.csv";

    expect(uploadReference(padded)).toBe("quarterly-budget.csv");
  });

  it("falls back rather than refusing when nothing survives", () => {
    expect(uploadReference(SPACE.repeat(5))).toBe("uploaded.csv");
    expect(uploadReference("\u0001\u0002")).toBe("uploaded.csv");
  });
});
