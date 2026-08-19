/**
 * Coordinate verification. Lexical only, fail-closed, and deterministic.
 *
 * Every refusal below is a refusal — not a downgrade, not a warning, not a
 * value rendered with a caveat. ADR-008 rule 1 is explicit about that, and a
 * verifier that softens on the hard cases is a formality rather than a check.
 *
 * What this CANNOT do is the thing worth repeating at the top of the file: it
 * cannot tell whether the model bound the right number to the right claim. A
 * candidate that hashes, sits at its stated coordinates, and normalises to its
 * stated value is ACCEPTED here even when the number is the wrong subject, the
 * wrong field, or the wrong year. Measuring how often that happens is what the
 * corpus and the report exist for.
 */

import {
  ExtractionCandidateSchema,
  type ExtractionCandidate,
} from "./candidate";
import { DOCUMENTS_BY_ID, sha256, type SealedDocument } from "./document";
import {
  NORMALIZATION_VERSION,
  isNormalizationFailure,
  normalize,
} from "./normalize";

export type RefusalReason =
  | "malformed-candidate"
  | "unknown-snapshot"
  | "hash-mismatch"
  | "locator-out-of-range"
  | "coordinate-text-mismatch"
  | "unsupported-normalization"
  | "unsupported-unit-syntax"
  | "value-not-in-extracted-text"
  | "unit-not-in-extracted-text";

export type Verdict =
  | { readonly accepted: true }
  | {
      readonly accepted: false;
      readonly reason: RefusalReason;
      readonly detail: string;
    };

function refuse(reason: RefusalReason, detail: string): Verdict {
  return { accepted: false, reason, detail };
}

export interface VerifyOptions {
  /**
   * Overrides the sealed bytes for one snapshot, so a test can model a document
   * that changed after retrieval without writing to the repository's fixtures.
   * The hash is recomputed from whatever bytes are used, never trusted from the
   * candidate — a verifier that believed the candidate's own hash would be
   * checking the candidate against itself.
   */
  readonly documentOverrides?: ReadonlyMap<string, Buffer>;
}

export function verifyCandidate(
  candidate: unknown,
  options: VerifyOptions = {},
): Verdict {
  const parsed = ExtractionCandidateSchema.safeParse(candidate);
  if (!parsed.success) {
    return refuse(
      "malformed-candidate",
      parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; "),
    );
  }
  const typed: ExtractionCandidate = parsed.data;

  const sealed: SealedDocument | undefined = DOCUMENTS_BY_ID.get(
    typed.snapshotId,
  );
  if (sealed === undefined) {
    return refuse(
      "unknown-snapshot",
      `no retained document with id ${JSON.stringify(typed.snapshotId)}`,
    );
  }

  const bytes =
    options.documentOverrides?.get(typed.snapshotId) ?? sealed.bytes;
  const actualHash = sha256(bytes);
  if (actualHash !== typed.contentSha256) {
    return refuse(
      "hash-mismatch",
      `document hashes ${actualHash}, candidate claims ${typed.contentSha256}`,
    );
  }

  const { startByte, endByte } = typed.locator;
  if (endByte > bytes.length) {
    return refuse(
      "locator-out-of-range",
      `locator ends at byte ${String(endByte)} but the document is ${String(bytes.length)} bytes`,
    );
  }

  // Decoded strictly: a slice that cuts a multi-byte character produces U+FFFD
  // rather than throwing, so the mismatch below is what catches it. That is why
  // the comparison is against the decoded slice and not against a re-encoding
  // of the candidate's own text.
  const atCoordinates = bytes.subarray(startByte, endByte).toString("utf8");
  if (atCoordinates !== typed.extractedText) {
    return refuse(
      "coordinate-text-mismatch",
      `bytes [${String(startByte)}, ${String(endByte)}) hold ${JSON.stringify(atCoordinates)}, candidate claims ${JSON.stringify(typed.extractedText)}`,
    );
  }

  if (typed.normalizationVersion !== NORMALIZATION_VERSION) {
    return refuse(
      "unsupported-normalization",
      `candidate was produced under normalisation ${typed.normalizationVersion}; this verifier implements ${NORMALIZATION_VERSION}`,
    );
  }

  const normalized = normalize(typed.extractedText);
  if (isNormalizationFailure(normalized)) {
    return refuse(
      normalized.kind === "unsupported-unit-syntax"
        ? "unsupported-unit-syntax"
        : "value-not-in-extracted-text",
      normalized.detail,
    );
  }
  if (normalized.value !== typed.value) {
    return refuse(
      "value-not-in-extracted-text",
      `${JSON.stringify(typed.extractedText)} normalises to ${String(normalized.value)}, candidate claims ${String(typed.value)}`,
    );
  }
  if (normalized.unit !== typed.unit) {
    return refuse(
      "unit-not-in-extracted-text",
      `${JSON.stringify(typed.extractedText)} normalises to unit ${normalized.unit}, candidate claims ${typed.unit}`,
    );
  }

  return { accepted: true };
}
