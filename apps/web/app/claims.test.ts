import { describe, expect, it } from "vitest";

import { canonicalBytes, extractSpecClaims } from "@dasher/dashboard-schema";
import { operatingSpendFixture } from "@dasher/ledger-domain/fixture";
import {
  compileLedgerPlan,
  DETERMINISTIC_LEDGER_PLANNER,
  planLedgerDashboard,
} from "@dasher/planner";
import { createHash } from "node:crypto";

import { evidenceCitations, persistedClaims } from "./claims";

/**
 * Built by the real ledger compiler rather than hand-written, because the two
 * things worth checking here are properties of a spec a compiler actually
 * produces: that every evidence item it emits can be cited, and that every
 * assertion it makes resolves against those citations. A fixture spec written
 * to satisfy this file would prove neither.
 */
function ledgerSpec() {
  const snapshot = operatingSpendFixture();
  return compileLedgerPlan(
    planLedgerDashboard(
      "Operating spend by category",
      snapshot.lines.map((line) => line.id),
    ),
    snapshot,
    {
      asOf: "2026-08-26T12:00:00.000Z",
      planner: DETERMINISTIC_LEDGER_PLANNER,
    },
  );
}

const spec = ledgerSpec();

/** What the upload path builds: every evidence item stored, ids handed back. */
function storedEverything(): ReadonlyMap<string, string> {
  return new Map(
    evidenceCitations(spec).map((citation, index) => [
      citation.specEvidenceId,
      `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    ]),
  );
}

describe("evidenceCitations", () => {
  it("cites every evidence item the spec carries, exactly once", () => {
    expect(evidenceCitations(spec).map((one) => one.specEvidenceId)).toEqual(
      spec.evidence.map((one) => one.id),
    );
  });

  it("locates each item by the name its own domain gave it", () => {
    // `ledger-line-salaries` is the ledger domain's identifier for the row of
    // the file that figure was read from. Using it as `coordinates` records the
    // domain's answer rather than inventing a cell grammar this layer would
    // have to guess at.
    const citation = evidenceCitations(spec).find(
      (one) => one.specEvidenceId === "ledger-line-salaries",
    );
    expect(citation?.record.coordinates).toBe("ledger-line-salaries");
    expect(citation?.record.evidenceKind).toBe("observed");
    expect(citation?.record.transformation).toBe(
      "Recorded as retrieved, without transformation.",
    );
  });

  it("names the calculated item as computed rather than retrieved", () => {
    // The one evidence item with no row behind it. Recording it as `observed`
    // would say Dasher read a total out of the file that the file never stated.
    const calculated = evidenceCitations(spec).filter(
      (one) => one.record.evidenceKind === "calculated",
    );
    expect(calculated).toHaveLength(1);
    expect(calculated[0]?.record.transformation).toBe(
      "Computed by Dasher from the retrieved values.",
    );
  });

  it("digests the evidence item as it is displayed", () => {
    const citation = evidenceCitations(spec)[0]!;
    const source = spec.evidence.find(
      (one) => one.id === citation.specEvidenceId,
    );
    expect(citation.record.contentSha256).toEqual(
      createHash("sha256").update(canonicalBytes(source)).digest(),
    );
  });

  it("falls back to retrieval when the source states no observation time", () => {
    for (const citation of evidenceCitations(spec)) {
      const source = spec.evidence.find(
        (one) => one.id === citation.specEvidenceId,
      )!;
      expect(citation.record.observedAt.toISOString()).toBe(
        source.observedAt ?? source.retrievedAt,
      );
      // The column pair the schema enforces: retrieval is never before
      // observation, whichever of the two this fell back to.
      expect(citation.record.observedAt.getTime()).toBeLessThanOrEqual(
        Date.parse(source.retrievedAt),
      );
    }
  });
});

describe("persistedClaims", () => {
  it("records one claim per assertion, in the schema's own order", () => {
    expect(persistedClaims(spec, new Map()).map((one) => one.pointer)).toEqual(
      extractSpecClaims(spec).map((one) => one.pointer),
    );
  });

  it("marks every claim complete when all its evidence was kept", () => {
    const claims = persistedClaims(spec, storedEverything());

    expect(claims.length).toBeGreaterThan(0);
    for (const claim of claims) {
      expect(claim.evidenceState, claim.pointer).toBe("complete");
      expect(claim.evidence.length, claim.pointer).toBeGreaterThan(0);
      for (const edge of claim.evidence) {
        expect(edge.relation).toBe("supports");
      }
    }
  });

  it("marks every claim unsupported when nothing was kept", () => {
    // The live-source path. Not an absence of recording — a recorded statement
    // that nothing durable stands behind these figures, which is what a gauge
    // read actually leaves behind.
    const claims = persistedClaims(spec, new Map());

    expect(claims.length).toBeGreaterThan(0);
    for (const claim of claims) {
      expect(claim.evidenceState, claim.pointer).toBe("unsupported");
      expect(claim.evidence, claim.pointer).toEqual([]);
    }
  });

  it("marks a claim partial when only some of its evidence was kept", () => {
    // A mixed map is not a state the product reaches today — an upload stores
    // all of its evidence or none — but `partial` is a value the column
    // accepts, and a claim that quietly reported `complete` on half its
    // evidence would be the exact overclaim this table exists to prevent.
    const everything = storedEverything();
    const mixed = new Map(everything);
    const withTwo = extractSpecClaims(spec).find(
      (claim) => claim.evidenceIds.length > 1,
    )!;
    mixed.delete(withTwo.evidenceIds[0]!);

    const claim = persistedClaims(spec, mixed).find(
      (one) => one.pointer === withTwo.pointer,
    );
    expect(claim?.evidenceState).toBe("partial");
    expect(claim?.evidence).toHaveLength(withTwo.evidenceIds.length - 1);
  });

  it("hashes the assertion, not the whole spec", () => {
    const claims = persistedClaims(spec, new Map());
    const digests = new Set(claims.map((one) => one.assertionSha256));

    // Distinct assertions get distinct digests; one digest for all of them
    // would mean the column was recording the document rather than the claim.
    expect(digests.size).toBe(claims.length);
    for (const digest of digests) expect(digest).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("produces the digest of the sub-document at the pointer", () => {
    const claim = persistedClaims(spec, new Map()).find(
      (one) => one.pointer === "/nextAction",
    );
    expect(claim?.assertionSha256).toBe(
      createHash("sha256")
        .update(canonicalBytes(spec.nextAction))
        .digest("hex"),
    );
  });
});
