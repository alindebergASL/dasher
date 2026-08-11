import { describe, expect, it } from "vitest";

import {
  canonicalizeDocument,
  outputValueDigest,
  runCalculation,
} from "./index";
import type { RuntimeValue } from "./schema";
import {
  R7_BUNDLE_BYTES,
  R7_CATALOG_BYTES,
  R7_CONTRACT_SET_BYTES,
  R7_EVIDENCE_BYTES,
  R7_FRESHNESS_VECTORS,
  R7_GRAPH_BYTES,
  R7_IDENTITIES,
  R7_INPUT_BYTES,
  R7_METER_BYTES,
  R7_OUTPUT_VALUE_BYTES,
  R7_RESULT_BYTES,
} from "./r7-fixtures";

const PLAN_NODE_IDS = [
  "00000000-0000-8000-8000-000000000301",
  "00000000-0000-8000-8000-000000000302",
  "00000000-0000-8000-8000-000000000303",
  "00000000-0000-8000-8000-000000000304",
  "00000000-0000-8000-8000-000000000305",
] as const;

const SECOND_FX_NODE_ID = "ffffffff-ffff-8fff-8fff-ffffffffffff";

const baseRequest = {
  rawGraphBytes: R7_GRAPH_BYTES,
  inputBytes: R7_INPUT_BYTES,
  catalogBytes: R7_CATALOG_BYTES,
  contractSetBytes: R7_CONTRACT_SET_BYTES,
  bundleBytes: R7_BUNDLE_BYTES,
  fxEvidenceBytes: R7_EVIDENCE_BYTES,
};

/** Re-encodes one edited fixture document canonically. */
function edited(
  text: string,
  mutate: (document: Record<string, unknown>) => void,
): string {
  const document = JSON.parse(text) as Record<string, unknown>;
  mutate(document);
  return canonicalizeDocument(document).canonicalText;
}

describe("fx-r7-usd-eur-boundary-v1 end to end", () => {
  const run = runCalculation(baseRequest);

  it("succeeds with the exact frozen result bytes and hash", () => {
    expect(run.error_code).toBeNull();
    expect(run.outcome?.state).toBe("succeeded");
    expect(run.outcome?.resultBytes).toBe(R7_RESULT_BYTES);
    expect(run.outcome?.result_sha256).toBe(R7_IDENTITIES.resultSha256);
    expect(run.outcome?.result_id).toBe(R7_IDENTITIES.resultId);
  });

  it("recomputes the exact frozen meter bytes and hash", () => {
    expect(run.outcome?.meterBytes).toBe(R7_METER_BYTES);
    expect(run.outcome?.meter_sha256).toBe(R7_IDENTITIES.meterSha256);
  });

  it("recomputes every meter field the plan freezes", () => {
    const meter = run.outcome?.meter;
    expect(meter?.input_bytes).toBe(R7_IDENTITIES.inputBytes);
    expect(meter?.ast_bytes).toBe(R7_IDENTITIES.astBytes);
    expect(meter?.node_count).toBe(5n);
    expect(meter?.max_depth).toBe(4n);
    expect(meter?.scanned_rows).toBe(1n);
    expect(meter?.group_count).toBe(1n);
    expect(meter?.max_group_rows).toBe(1n);
    expect(meter?.cumulative_intermediate_rows).toBe(4n);
    expect(meter?.final_output_rows).toBe(1n);
    expect(meter?.cumulative_intermediate_bytes).toBe(
      R7_IDENTITIES.cumulativeIntermediateBytes,
    );
    expect(meter?.output_bytes).toBe(R7_IDENTITIES.outputBytes);
    expect(meter?.primitive_steps).toBe(6n);
    expect(meter?.logical_allocation_bytes).toBe(
      R7_IDENTITIES.logicalAllocationBytes,
    );
    expect(meter?.max_literal_bytes).toBe(0n);
    expect(meter?.total_literal_bytes).toBe(0n);
    expect(meter?.max_literal_list_length).toBe(0n);
    expect(meter?.max_top_k).toBe(0n);
    expect(meter?.max_window_frame).toBe(0n);
    expect(meter?.max_coefficient_digits).toBe(3n);
    expect(meter?.max_scale).toBe(3n);
  });

  it("emits the frozen ordered intermediate byte vector", () => {
    expect(run.outcome?.intermediateByteVector).toEqual([
      ...R7_IDENTITIES.intermediateByteVector,
    ]);
  });

  it("recomputes the output entry and output-value digests", () => {
    expect(
      run.outcome?.outputEntrySha256.get(
        "00000000-0000-8000-8000-000000000305",
      ),
    ).toBe(R7_IDENTITIES.outputSha256);
    const value: RuntimeValue = {
      state: "present",
      type: "decimal",
      value: { coefficient: 925n, scale: 1n },
    };
    const digest = outputValueDigest({
      result_id: R7_IDENTITIES.resultId,
      node_id: "00000000-0000-8000-8000-000000000305",
      row_id: R7_IDENTITIES.groupRowId,
      field_id: null,
      value,
    });
    expect(digest.bytes).toBe(R7_OUTPUT_VALUE_BYTES);
    expect(digest.sha256).toBe(R7_IDENTITIES.outputValueSha256);
  });

  it("derives the frozen source and group row IDs and the group grain", () => {
    expect(run.validated?.input.rows[0]?.row_id).toBe(
      R7_IDENTITIES.sourceRowId,
    );
    expect(
      run.validated?.groupGrains.get("00000000-0000-8000-8000-000000000303"),
    ).toBe(R7_IDENTITIES.groupGrain);
    expect(run.outcome?.resultBytes).toContain(R7_IDENTITIES.groupRowId);
  });

  it("keeps the static admission bound at or above every runtime meter", () => {
    const staticMeter = run.validated?.staticMeter;
    const runtime = run.outcome?.meter;
    expect(staticMeter?.primitive_steps).toBeGreaterThanOrEqual(
      runtime?.primitive_steps as bigint,
    );
    expect(staticMeter?.cumulative_intermediate_bytes).toBeGreaterThanOrEqual(
      runtime?.cumulative_intermediate_bytes as bigint,
    );
    expect(staticMeter?.output_bytes).toBeGreaterThanOrEqual(
      runtime?.output_bytes as bigint,
    );
    expect(staticMeter?.logical_allocation_bytes).toBeGreaterThanOrEqual(
      runtime?.logical_allocation_bytes as bigint,
    );
    expect(staticMeter?.final_output_rows).toBeGreaterThanOrEqual(
      runtime?.final_output_rows as bigint,
    );
  });
});

describe("R7 boundary and failure vectors", () => {
  it("fx-fresh-inclusive succeeds at exactly 86,400,000 milliseconds", () => {
    const run = runCalculation(baseRequest);
    expect(run.outcome?.state).toBe("succeeded");
  });

  it("fx-stale-one-microsecond denies with stale_fx", () => {
    const observed = R7_FRESHNESS_VECTORS.staleOneMicrosecondObservedAt;
    const evidenceBytes = edited(R7_EVIDENCE_BYTES, (document) => {
      document.observed_at = observed;
    });
    const bundleBytes = edited(R7_BUNDLE_BYTES, (document) => {
      const entries = document.entries as Record<string, unknown>[];
      const entry = entries[0] as Record<string, unknown>;
      entry.observed_at = observed;
      entry.evidence_sha256 =
        R7_FRESHNESS_VECTORS.staleOneMicrosecondEvidenceSha256;
    });
    const graphBytes = edited(R7_GRAPH_BYTES, (document) => {
      document.fx_evidence_sha256 =
        R7_FRESHNESS_VECTORS.staleOneMicrosecondEvidenceSha256;
      document.common_bundle_sha256 = bundleSha(bundleBytes);
    });
    const run = runCalculation({
      ...baseRequest,
      rawGraphBytes: graphBytes,
      bundleBytes,
      fxEvidenceBytes: evidenceBytes,
    });
    expect(run.error_code).toBe("stale_fx");
    expect(run.outcome).toBeNull();
  });

  it("uses the plan's frozen evidence digest for the stale vector", () => {
    const evidenceBytes = edited(R7_EVIDENCE_BYTES, (document) => {
      document.observed_at = R7_FRESHNESS_VECTORS.staleOneMicrosecondObservedAt;
    });
    expect(rowHashOf(evidenceBytes)).toBe(
      R7_FRESHNESS_VECTORS.staleOneMicrosecondEvidenceSha256,
    );
  });

  it("fx-future-one-microsecond denies with stale_fx", () => {
    const observed = R7_FRESHNESS_VECTORS.futureOneMicrosecondObservedAt;
    const evidenceBytes = edited(R7_EVIDENCE_BYTES, (document) => {
      document.observed_at = observed;
    });
    expect(rowHashOf(evidenceBytes)).toBe(
      R7_FRESHNESS_VECTORS.futureOneMicrosecondEvidenceSha256,
    );
    const bundleBytes = edited(R7_BUNDLE_BYTES, (document) => {
      const entries = document.entries as Record<string, unknown>[];
      const entry = entries[0] as Record<string, unknown>;
      entry.observed_at = observed;
      entry.evidence_sha256 =
        R7_FRESHNESS_VECTORS.futureOneMicrosecondEvidenceSha256;
    });
    const graphBytes = edited(R7_GRAPH_BYTES, (document) => {
      document.fx_evidence_sha256 =
        R7_FRESHNESS_VECTORS.futureOneMicrosecondEvidenceSha256;
      document.common_bundle_sha256 = bundleSha(bundleBytes);
    });
    const run = runCalculation({
      ...baseRequest,
      rawGraphBytes: graphBytes,
      bundleBytes,
      fxEvidenceBytes: evidenceBytes,
    });
    expect(run.error_code).toBe("stale_fx");
  });

  it("fx-missing-before-stale prefers missing_fx_evidence over stale_fx", () => {
    const observed = R7_FRESHNESS_VECTORS.staleOneMicrosecondObservedAt;
    const evidenceBytes = edited(R7_EVIDENCE_BYTES, (document) => {
      document.observed_at = observed;
    });
    const bundleBytes = edited(R7_BUNDLE_BYTES, (document) => {
      const entries = document.entries as Record<string, unknown>[];
      const entry = { ...(entries[0] as Record<string, unknown>) };
      // The plan's JPY evidence ID, which this bundle does not carry.
      entry.evidence_id = "00000000-0000-8000-8000-000000000111";
      entry.observed_at = observed;
      document.entries = [entry];
    });
    const graphBytes = edited(R7_GRAPH_BYTES, (document) => {
      document.fx_evidence_sha256 =
        R7_FRESHNESS_VECTORS.staleOneMicrosecondEvidenceSha256;
      document.common_bundle_sha256 = bundleSha(bundleBytes);
    });
    const run = runCalculation({
      ...baseRequest,
      rawGraphBytes: graphBytes,
      bundleBytes,
      fxEvidenceBytes: evidenceBytes,
    });
    expect(run.error_code).toBe("missing_fx_evidence");
  });

  it("fx-direction-drift denies with missing_fx_evidence and never reciprocates", () => {
    const evidenceBytes = edited(R7_EVIDENCE_BYTES, (document) => {
      document.from_currency = "EUR";
      document.to_currency = "USD";
    });
    const sha = rowHashOf(evidenceBytes);
    const bundleBytes = edited(R7_BUNDLE_BYTES, (document) => {
      const entries = document.entries as Record<string, unknown>[];
      (entries[0] as Record<string, unknown>).evidence_sha256 = sha;
    });
    const graphBytes = edited(R7_GRAPH_BYTES, (document) => {
      document.fx_evidence_sha256 = sha;
      document.common_bundle_sha256 = bundleSha(bundleBytes);
    });
    const run = runCalculation({
      ...baseRequest,
      rawGraphBytes: graphBytes,
      bundleBytes,
      fxEvidenceBytes: evidenceBytes,
    });
    expect(run.error_code).toBe("missing_fx_evidence");
  });

  it("denies a currency_convert whose rate differs from the bound evidence", () => {
    const graphBytes = edited(R7_GRAPH_BYTES, (document) => {
      const nodes = document.nodes as Record<string, unknown>[];
      (nodes[4] as Record<string, unknown>).rate = {
        coefficient: "926",
        scale: "i64:3",
      };
    });
    const run = runCalculation({ ...baseRequest, rawGraphBytes: graphBytes });
    expect(run.error_code).toBe("missing_fx_evidence");
  });

  it("denies two FX pairs in one graph", () => {
    const graphBytes = edited(R7_GRAPH_BYTES, (document) => {
      const nodes = document.nodes as Record<string, unknown>[];
      const convert = nodes[4] as Record<string, unknown>;
      const second = { ...convert };
      // A deliberately arbitrary node ID: the plan's graph has exactly the
      // five nodes `...0301`..`...0305`, so a second FX node cannot reuse one.
      expect(PLAN_NODE_IDS).not.toContain(SECOND_FX_NODE_ID);
      second.node_id = SECOND_FX_NODE_ID;
      second.to_currency = "GBP";
      second.output_type = {
        ...(convert.output_type as Record<string, unknown>),
        currency: "GBP",
      };
      nodes.push(second);
    });
    const run = runCalculation({ ...baseRequest, rawGraphBytes: graphBytes });
    expect(run.error_code).toBe("missing_fx_evidence");
  });
});

describe("engine purity", () => {
  it("returns byte-identical output for repeated runs", () => {
    const first = runCalculation(baseRequest);
    const second = runCalculation(baseRequest);
    expect(first.outcome?.resultBytes).toBe(second.outcome?.resultBytes);
    expect(first.outcome?.meterBytes).toBe(second.outcome?.meterBytes);
  });

  it("never hashes host timing or memory", () => {
    const run = runCalculation(baseRequest);
    for (const marker of ["elapsed", "duration_ms", "heap", "rss", "wall"]) {
      expect(run.outcome?.meterBytes).not.toContain(marker);
      expect(run.outcome?.resultBytes).not.toContain(marker);
    }
  });
});

/* Small local helpers that recompute plan digests without an engine shortcut. */
import { rowHash } from "./canonical";

function rowHashOf(evidenceBytes: string): string {
  return rowHash("dasher.fx-rate-evidence.v1", evidenceBytes);
}

function bundleSha(bundleBytes: string): string {
  return rowHash("dasher.common-evidence-bundle.v1", bundleBytes);
}
