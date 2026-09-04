// @vitest-environment node
import { createHash } from "node:crypto";

import {
  canonicalBytes,
  extractSpecClaims,
  type DashboardSpec,
} from "@dasher/dashboard-schema";
import { beforeAll, describe, expect, it } from "vitest";

import { sampleDashboard } from "../test/sample-spec";

import { evidenceCitations, persistedClaims } from "./claims";

let spec: DashboardSpec;
beforeAll(async () => {
  spec = (await sampleDashboard()).dashboard;
});

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

  it("describes calculated items as computed and observed ones as retrieved", () => {
    const citations = evidenceCitations(spec);
    const byKind = new Map(
      spec.evidence.map((one) => [one.id, one.kind] as const),
    );
    for (const citation of citations) {
      const kind = byKind.get(citation.specEvidenceId);
      expect(citation.record.evidenceKind).toBe(kind);
      expect(citation.record.transformation).toMatch(
        kind === "observed" ? /retrieved/u : /Dasher/u,
      );
    }
  });

  it("digests the evidence item as it is displayed", () => {
    const first = spec.evidence[0]!;
    const citation = evidenceCitations(spec).find(
      (one) => one.specEvidenceId === first.id,
    )!;
    expect(citation.record.contentSha256).toEqual(
      createHash("sha256").update(canonicalBytes(first)).digest(),
    );
  });
});

describe("persistedClaims", () => {
  it("records one claim per assertion, in the schema's own order", () => {
    const claims = persistedClaims(spec, storedEverything());
    expect(claims.map((one) => one.pointer)).toEqual(
      extractSpecClaims(spec).map((one) => one.pointer),
    );
    expect(claims.length).toBeGreaterThan(3);
  });

  it("marks every claim complete when all its evidence was kept", () => {
    for (const claim of persistedClaims(spec, storedEverything())) {
      expect(claim.evidenceState).toBe("complete");
      expect(claim.evidence.length).toBeGreaterThan(0);
    }
  });

  it("marks every claim unsupported when nothing was kept", () => {
    for (const claim of persistedClaims(spec, new Map())) {
      expect(claim.evidenceState).toBe("unsupported");
      expect(claim.evidence).toEqual([]);
    }
  });

  it("marks a claim partial when only some of its evidence was kept", () => {
    const everything = storedEverything();
    const multi = extractSpecClaims(spec).find(
      (one) => one.evidenceIds.length > 1,
    );
    expect(multi).toBeDefined();
    const partial = new Map(everything);
    partial.delete(multi!.evidenceIds[0]!);
    const claim = persistedClaims(spec, partial).find(
      (one) => one.pointer === multi!.pointer,
    )!;
    expect(claim.evidenceState).toBe("partial");
  });

  it("hashes the assertion, not the whole spec", () => {
    const claims = persistedClaims(spec, storedEverything());
    const hashes = new Set(claims.map((one) => one.assertionSha256));
    expect(hashes.size).toBe(claims.length);
    for (const claim of claims) {
      expect(claim.assertionSha256).toMatch(/^[0-9a-f]{64}$/u);
    }
  });
});
