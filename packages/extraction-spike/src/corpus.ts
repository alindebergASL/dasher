/**
 * Hand-labelled candidates over the two real captures.
 *
 * Every coordinate here was computed from the actual bytes, not written by
 * hand, and every "what the number really is" label comes from the capture's
 * own snapshot sidecar (`fixtures/ucr/campus-facts-2025.snapshot.json`:
 * Fall 2025 undergraduate 24034, graduate 3599, total 27633; Fall 2024
 * 22599 / 3785 / 26384).
 *
 * The false-acceptance probes are the reason this file exists. They are not
 * malformed and they are not lies about the document — each one quotes real
 * characters at real coordinates and normalises correctly. They are wrong only
 * in the half nothing checks: which subject, which field, which period, which
 * denominator. If the verifier accepts them, that is the finding.
 */

import type { ExtractionCandidate } from "./candidate";
import { DOCUMENTS_BY_ID } from "./document";
import { NORMALIZATION_VERSION } from "./normalize";

const UCR = "ucr-campus-facts-2025";
const OPENAQ = "openaq-live-2026-08-18";

function hashOf(snapshotId: string): string {
  const document = DOCUMENTS_BY_ID.get(snapshotId);
  if (document === undefined) {
    throw new Error(`corpus references unknown snapshot ${snapshotId}`);
  }
  return document.contentSha256;
}

/**
 * Why the probes carry a category: "the model got it wrong" is not a finding.
 * "The model bound a real number to the wrong denominator, and no lexical check
 * can see that" is.
 */
export type WrongnessCategory =
  | "subject"
  | "field"
  | "reporting-period"
  | "unit"
  | "denominator"
  | "section"
  | "fragment";

export type Intent = "positive" | "refusal-probe" | "false-acceptance-probe";

export interface CorpusCase {
  readonly id: string;
  readonly what: string;
  readonly intent: Intent;
  /**
   * Does the claim match the source's own ground truth? Kept separate from
   * `intent` on purpose: a candidate can be factually right about the world and
   * still deserve refusal (a corrupted hash), and collapsing the two would let
   * a fail-closed refusal be reported as over-strictness.
   */
  readonly factuallyCorrect: boolean;
  readonly wrongness?: WrongnessCategory;
  readonly note: string;
  /** `unknown`, because malformed probes are deliberately not valid candidates. */
  readonly candidate: unknown;
  /** Models a document that changed after retrieval. */
  readonly documentOverrides?: ReadonlyMap<string, Buffer>;
}

function ucrCandidate(
  fields: Omit<
    ExtractionCandidate,
    "snapshotId" | "contentSha256" | "normalizationVersion"
  >,
): ExtractionCandidate {
  return {
    snapshotId: UCR,
    contentSha256: hashOf(UCR),
    normalizationVersion: NORMALIZATION_VERSION,
    ...fields,
  };
}

const TOTAL_2025_PROSE = { startByte: 18018, endByte: 18024 } as const;
const UNDERGRAD_2025_PROSE = { startByte: 18174, endByte: 18180 } as const;
const GRADUATE_2025_PROSE = { startByte: 18239, endByte: 18244 } as const;
const GRADUATE_2025_TABLE = { startByte: 22022, endByte: 22027 } as const;
const GROWTH_2025_PROSE = { startByte: 18071, endByte: 18075 } as const;
const GRADUATE_SHARE_PROSE = { startByte: 18264, endByte: 18269 } as const;
const TOTAL_2024_TABLE = { startByte: 22896, endByte: 22902 } as const;
const SAN_DIEGO_SHARE = { startByte: 30592, endByte: 30596 } as const;
const INSIDE_84_POINT_7 = { startByte: 38905, endByte: 38909 } as const;
const TOTAL_WITH_WORD = { startByte: 18018, endByte: 18033 } as const;

export const CORPUS: readonly CorpusCase[] = [
  // ---------------------------------------------------------------- positives
  {
    id: "positive/exact-coordinates",
    what: "Total Fall 2025 enrollment, quoted from the Overview paragraph",
    intent: "positive",
    factuallyCorrect: true,
    note: "Snapshot ground truth: Fall 2025 total is 27633.",
    candidate: ucrCandidate({
      locator: TOTAL_2025_PROSE,
      extractedText: "27,633",
      value: 27633,
      unit: "count",
      subject: "University of California, Riverside",
      field: "total-enrollment",
      reportingPeriod: "Fall 2025",
      claimPointer: "/components/0/metrics/0/value",
    }),
  },
  {
    id: "positive/thousands-separator",
    what: "Undergraduate count, exercising grouped thousands",
    intent: "positive",
    factuallyCorrect: true,
    note: "Snapshot ground truth: Fall 2025 undergraduate is 24034.",
    candidate: ucrCandidate({
      locator: UNDERGRAD_2025_PROSE,
      extractedText: "24,034",
      value: 24034,
      unit: "count",
      subject: "University of California, Riverside",
      field: "undergraduate-enrollment",
      reportingPeriod: "Fall 2025",
      claimPointer: "/components/0/metrics/1/value",
    }),
  },
  {
    id: "positive/percentage",
    what: "One-year growth, exercising percentage unit syntax",
    intent: "positive",
    factuallyCorrect: true,
    note: "26384 -> 27633 is +4.73%, which the source states as 4.7%.",
    candidate: ucrCandidate({
      locator: GROWTH_2025_PROSE,
      extractedText: "4.7%",
      value: 4.7,
      unit: "percent",
      subject: "University of California, Riverside",
      field: "one-year-enrollment-growth",
      reportingPeriod: "Fall 2024 to Fall 2025",
      claimPointer: "/components/0/metrics/0/change",
    }),
  },
  {
    id: "positive/duplicate-text-correct-occurrence",
    what: "Graduate count taken from the TABLE, where the same text also appears in prose",
    intent: "positive",
    factuallyCorrect: true,
    note: "`3,599` occurs twice in this document (prose 18239, table 22022). Both are the same fact; this candidate names the table occurrence and must verify there.",
    candidate: ucrCandidate({
      locator: GRADUATE_2025_TABLE,
      extractedText: "3,599",
      value: 3599,
      unit: "count",
      subject: "University of California, Riverside",
      field: "graduate-enrollment",
      reportingPeriod: "Fall 2025",
      claimPointer: "/components/0/metrics/2/value",
    }),
  },

  // ----------------------------------------------------------- refusal probes
  {
    id: "refusal/wrong-hash",
    what: "Correct claim, hash that does not match the document",
    intent: "refusal-probe",
    factuallyCorrect: true,
    note: "Fail-closed on provenance even when the number is right.",
    candidate: {
      ...ucrCandidate({
        locator: TOTAL_2025_PROSE,
        extractedText: "27,633",
        value: 27633,
        unit: "count",
        subject: "University of California, Riverside",
        field: "total-enrollment",
        reportingPeriod: "Fall 2025",
        claimPointer: "/components/0/metrics/0/value",
      }),
      contentSha256:
        `0${hashOf(UCR).slice(1)}` === hashOf(UCR)
          ? `1${hashOf(UCR).slice(1)}`
          : `0${hashOf(UCR).slice(1)}`,
    },
  },
  {
    id: "refusal/source-bytes-changed",
    what: "Correct claim and correct hash, against a document that changed after retrieval",
    intent: "refusal-probe",
    factuallyCorrect: true,
    note: "The page was edited. Immutable-store semantics make this corruption, not staleness, so it fails closed.",
    candidate: ucrCandidate({
      locator: TOTAL_2025_PROSE,
      extractedText: "27,633",
      value: 27633,
      unit: "count",
      subject: "University of California, Riverside",
      field: "total-enrollment",
      reportingPeriod: "Fall 2025",
      claimPointer: "/components/0/metrics/0/value",
    }),
    documentOverrides: new Map([
      [
        UCR,
        (() => {
          const original = DOCUMENTS_BY_ID.get(UCR);
          if (original === undefined) {
            throw new Error("missing UCR document");
          }
          const mutated = Buffer.from(original.bytes);
          // One digit, one byte: 27,633 becomes 27,634 in the source.
          mutated[TOTAL_2025_PROSE.endByte - 1] = "4".charCodeAt(0);
          return mutated;
        })(),
      ],
    ]),
  },
  {
    id: "refusal/wrong-coordinates",
    what: "Right text, coordinates shifted by one byte",
    intent: "refusal-probe",
    factuallyCorrect: true,
    note: "An off-by-one locator must not be tolerated, or coordinates stop meaning anything.",
    candidate: ucrCandidate({
      locator: { startByte: 18019, endByte: 18025 },
      extractedText: "27,633",
      value: 27633,
      unit: "count",
      subject: "University of California, Riverside",
      field: "total-enrollment",
      reportingPeriod: "Fall 2025",
      claimPointer: "/components/0/metrics/0/value",
    }),
  },
  {
    id: "refusal/correct-text-elsewhere-wrong-locator",
    what: "`27,633` really is in this document — but not at the coordinates claimed",
    intent: "refusal-probe",
    factuallyCorrect: true,
    note: "The ADR's named case: this is the difference between checking a citation and checking a search hit. The locator points at `24,034`.",
    candidate: ucrCandidate({
      locator: UNDERGRAD_2025_PROSE,
      extractedText: "27,633",
      value: 27633,
      unit: "count",
      subject: "University of California, Riverside",
      field: "total-enrollment",
      reportingPeriod: "Fall 2025",
      claimPointer: "/components/0/metrics/0/value",
    }),
  },
  {
    id: "refusal/unsupported-normalization",
    what: "Candidate produced under a normalisation this verifier does not implement",
    intent: "refusal-probe",
    factuallyCorrect: true,
    note: "Reinterpreting it under the current rules would silently re-decide what verifies.",
    candidate: {
      ...ucrCandidate({
        locator: TOTAL_2025_PROSE,
        extractedText: "27,633",
        value: 27633,
        unit: "count",
        subject: "University of California, Riverside",
        field: "total-enrollment",
        reportingPeriod: "Fall 2025",
        claimPointer: "/components/0/metrics/0/value",
      }),
      normalizationVersion: "0",
    },
  },
  {
    id: "refusal/value-absent-from-extracted-text",
    what: "Text and coordinates verify; the claimed value is not what the text says",
    intent: "refusal-probe",
    factuallyCorrect: false,
    wrongness: "field",
    note: "The undergraduate figure claimed against the total's characters.",
    candidate: ucrCandidate({
      locator: TOTAL_2025_PROSE,
      extractedText: "27,633",
      value: 24034,
      unit: "count",
      subject: "University of California, Riverside",
      field: "total-enrollment",
      reportingPeriod: "Fall 2025",
      claimPointer: "/components/0/metrics/0/value",
    }),
  },
  {
    id: "refusal/unsupported-unit-syntax",
    what: "Span runs past the number into the word after it",
    intent: "refusal-probe",
    factuallyCorrect: true,
    note: "`27,633 students` has a unit spelling of `students`, which is not in the version 1 table.",
    candidate: ucrCandidate({
      locator: TOTAL_WITH_WORD,
      extractedText: "27,633 students",
      value: 27633,
      unit: "count",
      subject: "University of California, Riverside",
      field: "total-enrollment",
      reportingPeriod: "Fall 2025",
      claimPointer: "/components/0/metrics/0/value",
    }),
  },
  {
    id: "refusal/locator-out-of-range",
    what: "Coordinates past the end of the document",
    intent: "refusal-probe",
    factuallyCorrect: false,
    wrongness: "field",
    note: "Must refuse rather than throw or clamp.",
    candidate: ucrCandidate({
      locator: { startByte: 999_000, endByte: 999_006 },
      extractedText: "27,633",
      value: 27633,
      unit: "count",
      subject: "University of California, Riverside",
      field: "total-enrollment",
      reportingPeriod: "Fall 2025",
      claimPointer: "/components/0/metrics/0/value",
    }),
  },
  {
    id: "refusal/multibyte-cut",
    what: "Coordinates that slice through a multi-byte character",
    intent: "refusal-probe",
    factuallyCorrect: false,
    wrongness: "unit",
    note: "Byte 1135 is the second byte of U+00B5 in the OpenAQ capture. The decode yields U+FFFD, so the text comparison refuses.",
    candidate: {
      snapshotId: OPENAQ,
      contentSha256: hashOf(OPENAQ),
      normalizationVersion: NORMALIZATION_VERSION,
      locator: { startByte: 1135, endByte: 1141 },
      extractedText: "µg/m³",
      value: 0,
      unit: "ug_per_m3",
      subject: "Sacramento PM2.5 sensor",
      field: "unit-of-measure",
      reportingPeriod: "2026-08-18",
      claimPointer: "/components/0/metrics/0/unit",
    },
  },
  {
    id: "refusal/malformed-candidate",
    what: "Candidate missing required semantic fields and carrying a bad pointer",
    intent: "refusal-probe",
    factuallyCorrect: false,
    wrongness: "field",
    note: "The schema is the first gate; an unparseable candidate never reaches the document.",
    candidate: {
      snapshotId: UCR,
      contentSha256: hashOf(UCR),
      normalizationVersion: NORMALIZATION_VERSION,
      locator: { startByte: 18018, endByte: 18024 },
      extractedText: "27,633",
      value: 27633,
      unit: "count",
      claimPointer: "components/0",
    },
  },

  // -------------------------------------------------- false-acceptance probes
  {
    id: "false-acceptance/wrong-subject",
    what: "UCR's enrollment total, attributed to UCLA",
    intent: "false-acceptance-probe",
    factuallyCorrect: false,
    wrongness: "subject",
    note: "Nothing in the document text distinguishes which campus a reader of the number alone is talking about.",
    candidate: ucrCandidate({
      locator: TOTAL_2025_PROSE,
      extractedText: "27,633",
      value: 27633,
      unit: "count",
      subject: "University of California, Los Angeles",
      field: "total-enrollment",
      reportingPeriod: "Fall 2025",
      claimPointer: "/components/0/metrics/0/value",
    }),
  },
  {
    id: "false-acceptance/wrong-field",
    what: "The undergraduate figure bound to total enrollment",
    intent: "false-acceptance-probe",
    factuallyCorrect: false,
    wrongness: "field",
    note: "This is ADR-008's worked example, in the document it was drawn from: 24034 is undergraduates, 27633 is the total.",
    candidate: ucrCandidate({
      locator: UNDERGRAD_2025_PROSE,
      extractedText: "24,034",
      value: 24034,
      unit: "count",
      subject: "University of California, Riverside",
      field: "total-enrollment",
      reportingPeriod: "Fall 2025",
      claimPointer: "/components/0/metrics/0/value",
    }),
  },
  {
    id: "false-acceptance/wrong-reporting-period",
    what: "The Fall 2024 total presented as Fall 2025",
    intent: "false-acceptance-probe",
    factuallyCorrect: false,
    wrongness: "reporting-period",
    note: "26384 is the 2024 column of the same table row. Adjacent cell, different year, identical lexical evidence.",
    candidate: ucrCandidate({
      locator: TOTAL_2024_TABLE,
      extractedText: "26,384",
      value: 26384,
      unit: "count",
      subject: "University of California, Riverside",
      field: "total-enrollment",
      reportingPeriod: "Fall 2025",
      claimPointer: "/components/0/metrics/0/value",
    }),
  },
  {
    id: "false-acceptance/wrong-unit",
    what: "A headcount bound to a field that means a share",
    intent: "false-acceptance-probe",
    factuallyCorrect: false,
    wrongness: "unit",
    note: "3599 is the graduate headcount; the graduate SHARE is 13.0%. The lexical unit `count` is correct for the characters and wrong for the field.",
    candidate: ucrCandidate({
      locator: GRADUATE_2025_PROSE,
      extractedText: "3,599",
      value: 3599,
      unit: "count",
      subject: "University of California, Riverside",
      field: "graduate-share-of-total",
      reportingPeriod: "Fall 2025",
      claimPointer: "/components/0/metrics/2/value",
    }),
  },
  {
    id: "false-acceptance/wrong-denominator",
    what: "Graduate share of the TOTAL presented as a share of undergraduates",
    intent: "false-acceptance-probe",
    factuallyCorrect: false,
    wrongness: "denominator",
    note: "The source says 13.0% of the Fall 2025 total. As a share of undergraduates it would be 15.0%. Correct numerator, wrong base.",
    candidate: ucrCandidate({
      locator: GRADUATE_SHARE_PROSE,
      extractedText: "13.0%",
      value: 13,
      unit: "percent",
      subject: "University of California, Riverside",
      field: "graduate-share-of-undergraduate",
      reportingPeriod: "Fall 2025",
      claimPointer: "/components/0/metrics/2/change",
    }),
  },
  {
    id: "false-acceptance/wrong-section",
    what: "`4.7%` lifted from the Geographic Origin table into the growth claim",
    intent: "false-acceptance-probe",
    factuallyCorrect: false,
    wrongness: "section",
    note: "Byte 30592 is San Diego County's share of undergraduates, which is also 4.7%. A real collision in a real document: same characters, unrelated fact.",
    candidate: ucrCandidate({
      locator: SAN_DIEGO_SHARE,
      extractedText: "4.7%",
      value: 4.7,
      unit: "percent",
      subject: "University of California, Riverside",
      field: "one-year-enrollment-growth",
      reportingPeriod: "Fall 2024 to Fall 2025",
      claimPointer: "/components/0/metrics/0/change",
    }),
  },
  {
    id: "false-acceptance/fragment-of-a-longer-number",
    what: "A span that cuts `84.7%` down to `4.7%`",
    intent: "false-acceptance-probe",
    factuallyCorrect: false,
    wrongness: "fragment",
    note: "Not in ADR-008's list, and found by building this corpus. The characters are genuinely at those coordinates and normalise correctly; the number is still a fragment of a different number, because nothing checks what abuts the span.",
    candidate: ucrCandidate({
      locator: INSIDE_84_POINT_7,
      extractedText: "4.7%",
      value: 4.7,
      unit: "percent",
      subject: "University of California, Riverside",
      field: "one-year-enrollment-growth",
      reportingPeriod: "Fall 2024 to Fall 2025",
      claimPointer: "/components/0/metrics/0/change",
    }),
  },
];
