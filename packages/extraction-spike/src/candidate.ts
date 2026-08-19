/**
 * The typed extraction candidate ADR-008 specifies.
 *
 * Two halves, and keeping them visibly separate is the point of the type:
 *
 *   * the LEXICAL half — snapshot, hash, locator, text, normalisation version,
 *     value, unit — is what trusted code can check;
 *   * the SEMANTIC half — subject, field, reporting period — is what the model
 *     claims those characters mean, and nothing here checks it.
 *
 * The semantic fields are required anyway. They cannot be verified, but they
 * can be *stated*, and a mapping written down is one a reviewer or a later
 * cross-check can inspect. An unwritten mapping is neither verifiable nor
 * inspectable, which is strictly worse.
 */

import { z } from "zod";

const NonEmpty = z.string().trim().min(1).max(200);

export const ExtractionCandidateSchema = z
  .strictObject({
    /** Which retained document, immutably. */
    snapshotId: NonEmpty,
    /** That the document has not changed since retrieval. Lowercase hex. */
    contentSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    /** Half-open byte range `[start, end)` into the sealed bytes. */
    locator: z
      .strictObject({
        startByte: z.int().nonnegative(),
        endByte: z.int().positive(),
      })
      .refine((locator) => locator.endByte > locator.startByte, {
        message: "locator endByte must be after startByte",
      }),
    /** The literal characters the candidate claims are at those coordinates. */
    extractedText: z.string().min(1).max(400),
    /** Which normalisation produced `value` and `unit` from `extractedText`. */
    normalizationVersion: NonEmpty,
    value: z.number().finite(),
    /** A canonical unit identity, not a spelling. */
    unit: NonEmpty,

    // --- Everything below is model-authored and unverified. ---
    subject: NonEmpty,
    field: NonEmpty,
    reportingPeriod: NonEmpty,
    claimPointer: z.string().regex(/^\/[^\s]*$/u),
  })
  .readonly();

export type ExtractionCandidate = z.infer<typeof ExtractionCandidateSchema>;
