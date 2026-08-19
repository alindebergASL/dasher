import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { DOCUMENTS_BY_ID } from "./document";
import { NORMALIZATION_VERSION } from "./normalize";
import { verifyCandidate, type RefusalReason } from "./verify";

const UCR = "ucr-campus-facts-2025";

function ucrHash(): string {
  const document = DOCUMENTS_BY_ID.get(UCR);
  if (document === undefined) {
    throw new Error("UCR capture missing");
  }
  return document.contentSha256;
}

/** The known-good candidate every case below perturbs by exactly one thing. */
function baseline(): Record<string, unknown> {
  return {
    snapshotId: UCR,
    contentSha256: ucrHash(),
    normalizationVersion: NORMALIZATION_VERSION,
    locator: { startByte: 18018, endByte: 18024 },
    extractedText: "27,633",
    value: 27633,
    unit: "count",
    subject: "University of California, Riverside",
    field: "total-enrollment",
    reportingPeriod: "Fall 2025",
    claimPointer: "/components/0/metrics/0/value",
  };
}

function refusalFor(overrides: Record<string, unknown>): RefusalReason {
  const verdict = verifyCandidate({ ...baseline(), ...overrides });
  if (verdict.accepted) {
    throw new Error("expected a refusal, got acceptance");
  }
  return verdict.reason;
}

describe("the baseline verifies", () => {
  it("accepts a candidate that is right about everything checkable", () => {
    // Without this, every refusal test below could pass against a verifier that
    // refuses unconditionally.
    expect(verifyCandidate(baseline())).toEqual({ accepted: true });
  });
});

describe("deterministic refusals", () => {
  it("refuses an unknown snapshot", () => {
    expect(refusalFor({ snapshotId: "no-such-document" })).toBe(
      "unknown-snapshot",
    );
  });

  it("refuses a hash that is not the snapshot's registered hash", () => {
    const wrong = `${ucrHash().startsWith("0") ? "1" : "0"}${ucrHash().slice(1)}`;
    expect(refusalFor({ contentSha256: wrong })).toBe(
      "snapshot-identity-mismatch",
    );
  });

  it("refuses when the source bytes changed after retrieval", () => {
    const original = DOCUMENTS_BY_ID.get(UCR);
    if (original === undefined) {
      throw new Error("UCR capture missing");
    }
    const mutated = Buffer.from(original.bytes);
    mutated[18023] = "4".charCodeAt(0);
    const verdict = verifyCandidate(baseline(), {
      documentOverrides: new Map([[UCR, mutated]]),
    });
    expect(verdict).toMatchObject({ accepted: false, reason: "hash-mismatch" });
  });

  it("refuses a candidate that redefines the snapshot to match altered bytes", () => {
    // The failure this now guards is the one the first version shipped: the
    // recomputed hash was compared only to the candidate's own copy, so a
    // candidate that altered the bytes AND claimed the altered hash was
    // self-consistent and therefore accepted. A snapshot id names immutable
    // sealed bytes; being consistent about some document is not being about
    // the retained one.
    const original = DOCUMENTS_BY_ID.get(UCR);
    if (original === undefined) {
      throw new Error("UCR capture missing");
    }
    const mutated = Buffer.from(original.bytes);
    mutated[18023] = "4".charCodeAt(0);
    const mutatedHash = createHash("sha256").update(mutated).digest("hex");
    const verdict = verifyCandidate(
      {
        ...baseline(),
        contentSha256: mutatedHash,
        extractedText: "27,634",
        value: 27634,
      },
      { documentOverrides: new Map([[UCR, mutated]]) },
    );
    expect(verdict).toMatchObject({
      accepted: false,
      reason: "snapshot-identity-mismatch",
    });
  });

  it("measures the bytes against the registered hash, not the candidate's", () => {
    // Complementary direction: candidate honest about the sealed identity,
    // bytes altered underneath it. Must still refuse, and for the other reason.
    const original = DOCUMENTS_BY_ID.get(UCR);
    if (original === undefined) {
      throw new Error("UCR capture missing");
    }
    const mutated = Buffer.from(original.bytes);
    mutated[18023] = "4".charCodeAt(0);
    expect(
      verifyCandidate(baseline(), {
        documentOverrides: new Map([[UCR, mutated]]),
      }),
    ).toMatchObject({ accepted: false, reason: "hash-mismatch" });
  });

  it("refuses coordinates past the end of the document", () => {
    expect(
      refusalFor({ locator: { startByte: 999_000, endByte: 999_006 } }),
    ).toBe("locator-out-of-range");
  });

  it("refuses coordinates shifted by one byte", () => {
    expect(refusalFor({ locator: { startByte: 18019, endByte: 18025 } })).toBe(
      "coordinate-text-mismatch",
    );
  });

  it("refuses correct text that is somewhere else in the document", () => {
    // `27,633` really does occur at 18018 and 22975. Pointing at 18174, which
    // holds `24,034`, must refuse: this is the difference between checking a
    // citation and checking a search hit.
    expect(refusalFor({ locator: { startByte: 18174, endByte: 18180 } })).toBe(
      "coordinate-text-mismatch",
    );
  });

  it("refuses a normalisation version it does not implement", () => {
    expect(refusalFor({ normalizationVersion: "0" })).toBe(
      "unsupported-normalization",
    );
  });

  it("refuses a value that is not what the extracted text says", () => {
    expect(refusalFor({ value: 24034 })).toBe("value-not-in-extracted-text");
  });

  it("refuses a unit that is not what the extracted text says", () => {
    expect(
      refusalFor({
        locator: { startByte: 18071, endByte: 18075 },
        extractedText: "4.7%",
        value: 4.7,
        unit: "count",
      }),
    ).toBe("unit-not-in-extracted-text");
  });

  it("refuses a span that runs into the following word", () => {
    expect(
      refusalFor({
        locator: { startByte: 18018, endByte: 18033 },
        extractedText: "27,633 students",
      }),
    ).toBe("unsupported-unit-syntax");
  });

  it.each([
    ["a missing semantic field", { subject: undefined }],
    ["a claim pointer that is not a pointer", { claimPointer: "components/0" }],
    ["a hash that is not hex", { contentSha256: "not-a-hash" }],
    ["an inverted locator", { locator: { startByte: 18024, endByte: 18018 } }],
    ["an unknown extra field", { confidence: "high" }],
  ])("refuses %s before touching the document", (_label, override) => {
    expect(refusalFor(override)).toBe("malformed-candidate");
  });
});

describe("what the verifier cannot see", () => {
  it("accepts a real number bound to the wrong subject", () => {
    // Recorded as a test, not just as prose in the report, so that any future
    // claim of semantic verification breaks here first.
    expect(
      verifyCandidate({
        ...baseline(),
        subject: "University of California, Los Angeles",
      }),
    ).toEqual({ accepted: true });
  });

  it("accepts a real number bound to the wrong field and period", () => {
    expect(
      verifyCandidate({
        ...baseline(),
        locator: { startByte: 22896, endByte: 22902 },
        extractedText: "26,384",
        value: 26384,
        field: "total-enrollment",
        reportingPeriod: "Fall 2025",
      }),
    ).toEqual({ accepted: true });
  });
});
