import { createHash } from "node:crypto";

import type {
  PersistedClaim,
  RecordEvidenceInput,
} from "@dasher/control-plane";
import {
  canonicalBytes,
  extractSpecClaims,
  type DashboardSpec,
  type Evidence,
} from "@dasher/dashboard-schema";

/**
 * The layer that turns a compiled dashboard into rows in `evidence_records`,
 * `claims`, and `claim_evidence`.
 *
 * WHY IT IS HERE RATHER THAN IN EITHER NEIGHBOUR. `@dasher/dashboard-schema`
 * decides what an assertion is but holds no Node types on purpose, so it cannot
 * take a SHA-256. `@dasher/control-plane` writes rows but deliberately does not
 * interpret a spec — a repository that understood the payload would be a second
 * place the contract lives. What is left is exactly this: the digest, and the
 * one judgement neither of them can make, which is whether the evidence behind
 * an assertion was actually kept.
 *
 * WHY THAT JUDGEMENT MATTERS. A dashboard built from an uploaded file has bytes
 * standing behind its figures. One built from a live API read shows the same
 * evidence panel and has nothing durable underneath it — the reading was true
 * when it was taken and cannot be produced again. Recording both as though they
 * were equally supported would make the evidence chain decorative, which is the
 * one thing it cannot be.
 */

/**
 * What was done to the retrieved bytes to get the figure.
 *
 * `evidence_records.transformation` is `NOT NULL` and the spec's evidence kind
 * is the only thing in the document that answers it today. A richer answer — a
 * cell range, a formula — has to come from the domain that did the work, and no
 * domain says it yet. Naming the act is honest; inventing a coordinate grammar
 * here would not be.
 */
const TRANSFORMATION_BY_KIND: Record<Evidence["kind"], string> = {
  observed: "Recorded as retrieved, without transformation.",
  calculated: "Computed by Dasher from the retrieved values.",
  interpreted: "Interpreted by Dasher from the retrieved values.",
  recommended: "Proposed by Dasher from the retrieved values.",
};

/** One evidence item, ready to be stored against a snapshot. */
export interface EvidenceCitation {
  /** The spec-local id, which is what a claim's `evidenceIds` refer to. */
  readonly specEvidenceId: string;
  readonly record: Omit<
    RecordEvidenceInput,
    "snapshotId" | "requestId" | "deploymentRevision"
  >;
}

export function evidenceCitations(
  spec: DashboardSpec,
): readonly EvidenceCitation[] {
  return spec.evidence.map((evidence) => ({
    specEvidenceId: evidence.id,
    record: {
      evidenceKind: evidence.kind,
      // The domain's own name for where this came from inside the source. For
      // a ledger upload that is `ledger-line-<line_id>`, which locates the row
      // of the file the figure was read from.
      coordinates: evidence.id,
      transformation: TRANSFORMATION_BY_KIND[evidence.kind],
      // The evidence as displayed, canonicalised the same way the spec is
      // stored, so this digest and one taken from the stored bytes agree. What
      // it detects is the evidence panel being edited away from the row that
      // is supposed to answer for it.
      contentSha256: sha256(canonicalBytes(evidence)),
      // When the source says this was true. `observedAt` is optional on the
      // spec's evidence and the column is not, so retrieval stands in — which
      // is the weaker of the two facts and therefore the safe one to fall back
      // to. `retrieved_at >= observed_at` holds either way.
      observedAt: new Date(evidence.observedAt ?? evidence.retrievedAt),
    },
  }));
}

/**
 * Every assertion in the spec, with its support resolved against what was kept.
 *
 * `recordIdBySpecEvidenceId` is empty for a dashboard whose source retained no
 * bytes, and every claim then comes back `unsupported` with no edges — which is
 * the true statement about a live read, not a failure to record one.
 *
 * `contradicted` and `stale` are never produced. Contradiction needs two
 * evidence items disagreeing about one figure, which nothing computes;
 * staleness needs a freshness horizon, which the spec carries as a label for a
 * reader rather than as a rule. Emitting either from a guess would put an
 * invention in the column a reviewer trusts most.
 */
export function persistedClaims(
  spec: DashboardSpec,
  recordIdBySpecEvidenceId: ReadonlyMap<string, string>,
): readonly PersistedClaim[] {
  return extractSpecClaims(spec).map((claim) => {
    const evidence = claim.evidenceIds.flatMap((specEvidenceId) => {
      const evidenceId = recordIdBySpecEvidenceId.get(specEvidenceId);
      return evidenceId === undefined
        ? []
        : [{ evidenceId, relation: "supports" as const }];
    });

    return {
      pointer: claim.pointer,
      label: claim.label,
      salience: claim.salience,
      evidenceState:
        evidence.length === 0
          ? "unsupported"
          : evidence.length === claim.evidenceIds.length
            ? "complete"
            : "partial",
      assertionSha256: sha256(claim.assertionBytes).toString("hex"),
      evidence,
    };
  });
}

function sha256(bytes: Uint8Array): Buffer {
  return createHash("sha256").update(bytes).digest();
}
