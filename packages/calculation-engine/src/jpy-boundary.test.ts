/**
 * The `fx-jpy-positive-tie` and `fx-jpy-negative-tie` boundary vectors.
 *
 * Both are exact transformations of the frozen `fx-r7-usd-eur-boundary-v1`
 * fixture, applied here in the plan's listed order before any hash is
 * recomputed. Nothing is transcribed from a previous run: every digest, byte
 * length, UUID, and value below is recomputed from the base bytes and the
 * transformation, then compared against the literals the plan states.
 *
 * The boundary itself is the JPY minor-unit exponent of zero with rate `1.5`:
 * `1 USD` quantizes at exactly `1.5` and `-1 USD` at exactly `-1.5`, the two
 * symmetric half-even ties, which round to `2` and `-2`.
 */

import { describe, expect, it } from "vitest";

import { rowHash } from "./canonical";
import {
  type CalculationRun,
  canonicalizeDocument,
  outputValueDigest,
  parseCanonicalInputTable,
  parseFieldCatalogSnapshot,
  parseMetricContractSet,
  parseStrictJson,
  runCalculation,
} from "./index";
import type { RuntimeValue } from "./schema";
import {
  R7_BUNDLE_BYTES,
  R7_CATALOG_BYTES,
  R7_CONTRACT_SET_BYTES,
  R7_GRAPH_BYTES,
  R7_INPUT_BYTES,
  R7_JPY_VECTORS,
} from "./r7-fixtures";

type Document = Record<string, unknown>;

const BASE_EVIDENCE_ID = "00000000-0000-8000-8000-000000000106";
const JPY_EVIDENCE_ID = R7_JPY_VECTORS.positive.evidenceId;
const CONVERT_NODE_ID = "00000000-0000-8000-8000-000000000305";

/** Re-encodes an edited fixture document canonically. */
function encode(text: string, mutate: (document: Document) => void): string {
  const document = JSON.parse(text) as Document;
  mutate(document);
  return canonicalizeDocument(document).canonicalText;
}

interface JpyFixture {
  readonly inputBytes: string;
  readonly catalogBytes: string;
  readonly evidenceBytes: string;
  readonly bundleBytes: string;
  readonly contractSetBytes: string;
  readonly rawGraphBytes: string;
}

/**
 * Applies the plan's JPY transformation to the base fixture.
 *
 * `amountCoefficient` is the only difference between the two vectors: the
 * positive tie replaces the input amount coefficient `100` by `1`, the negative
 * tie by `-1`.
 */
function jpyFixture(amountCoefficient: string): JpyFixture {
  const inputBytes = encode(R7_INPUT_BYTES, (document) => {
    const rows = document.rows as Document[];
    const values = (rows[0] as Document).values as Document[];
    const amount = values[1] as Document;
    expect((amount.value as Document).coefficient).toBe("100");
    amount.value = { coefficient: amountCoefficient, scale: "i64:0" };
  });
  const inputSha = rowHash("dasher.canonical-input-table.v1", inputBytes);

  const catalogBytes = encode(R7_CATALOG_BYTES, (document) => {
    document.input_sha256 = inputSha;
    for (const field of document.fields as Document[]) {
      expect(field.lineage_evidence_ids).toEqual([BASE_EVIDENCE_ID]);
      field.lineage_evidence_ids = [JPY_EVIDENCE_ID];
    }
  });
  const catalogSha = rowHash("dasher.field-catalog-snapshot.v1", catalogBytes);

  const evidenceBytes = R7_JPY_VECTORS.positive.evidenceBytes;
  const evidenceSha = rowHash("dasher.fx-rate-evidence.v1", evidenceBytes);

  const bundleBytes = encode(R7_BUNDLE_BYTES, (document) => {
    const entry = (document.entries as Document[])[0] as Document;
    entry.evidence_id = JPY_EVIDENCE_ID;
    entry.evidence_sha256 = evidenceSha;
    entry.source_sha256 = inputSha;
  });
  const bundleSha = rowHash("dasher.common-evidence-bundle.v1", bundleBytes);

  const contractSetBytes = encode(R7_CONTRACT_SET_BYTES, (document) => {
    const contract = (document.contracts as Document[])[0] as Document;
    contract.lineage_evidence_ids = [JPY_EVIDENCE_ID];
    contract.name = R7_JPY_VECTORS.positive.contractName;
    contract.definition = R7_JPY_VECTORS.positive.contractDefinition;
    contract.currency = "JPY";
  });

  const rawGraphBytes = encode(R7_GRAPH_BYTES, (document) => {
    document.input_sha256 = inputSha;
    document.field_catalog_sha256 = catalogSha;
    document.common_bundle_sha256 = bundleSha;
    document.fx_evidence_id = JPY_EVIDENCE_ID;
    document.fx_evidence_sha256 = evidenceSha;
    const nodes = document.nodes as Document[];
    const convert = nodes.find(
      (node) => node.node_id === CONVERT_NODE_ID,
    ) as Document;
    convert.fx_evidence_id = JPY_EVIDENCE_ID;
    convert.to_currency = "JPY";
    convert.rate = { coefficient: "15", scale: "i64:1" };
    convert.scale = "i64:0";
    (convert.output_type as Document).currency = "JPY";
  });

  return {
    inputBytes,
    catalogBytes,
    evidenceBytes,
    bundleBytes,
    contractSetBytes,
    rawGraphBytes,
  };
}

function runFixture(fixture: JpyFixture): CalculationRun {
  return runCalculation({
    rawGraphBytes: fixture.rawGraphBytes,
    inputBytes: fixture.inputBytes,
    catalogBytes: fixture.catalogBytes,
    contractSetBytes: fixture.contractSetBytes,
    bundleBytes: fixture.bundleBytes,
    fxEvidenceBytes: fixture.evidenceBytes,
  });
}

const parseInput = (
  text: string,
): ReturnType<typeof parseCanonicalInputTable> =>
  parseCanonicalInputTable(parseStrictJson(text), text);

const parseCatalog = (
  text: string,
): ReturnType<typeof parseFieldCatalogSnapshot> =>
  parseFieldCatalogSnapshot(parseStrictJson(text), text);

const parseContracts = (
  text: string,
): ReturnType<typeof parseMetricContractSet> =>
  parseMetricContractSet(parseStrictJson(text), text);

/** The one output row of a succeeded run, read back from its result bytes. */
function outputRow(run: CalculationRun): {
  row_id: string;
  value: RuntimeValue;
} {
  const result = JSON.parse(run.outcome?.resultBytes as string) as {
    outputs: { rows: { row_id: string; value: RuntimeValue }[] }[];
  };
  return result.outputs[0]?.rows[0] as { row_id: string; value: RuntimeValue };
}

const POSITIVE = jpyFixture("1");
const NEGATIVE = jpyFixture("-1");

describe("fx-jpy-positive-tie", () => {
  const expected = R7_JPY_VECTORS.positive;
  const fixture = POSITIVE;
  const run = runFixture(fixture);

  it("recomputes the input, catalog, evidence, bundle, and contract digests", () => {
    const input = parseInput(fixture.inputBytes);
    expect(input.input_sha256).toBe(expected.inputSha256);
    expect(input.canonicalBytes).toBe(expected.inputBytes);

    const catalog = parseCatalog(fixture.catalogBytes);
    expect(catalog.catalog_sha256).toBe(expected.catalogSha256);
    expect(catalog.fields.map((field) => field.entry_sha256)).toEqual([
      ...expected.entrySha256,
    ]);

    expect(rowHash("dasher.fx-rate-evidence.v1", fixture.evidenceBytes)).toBe(
      expected.evidenceSha256,
    );
    expect(
      rowHash("dasher.common-evidence-bundle.v1", fixture.bundleBytes),
    ).toBe(expected.bundleSha256);

    const contractSet = parseContracts(fixture.contractSetBytes);
    expect(contractSet.contract_set_sha256).toBe(expected.contractSetSha256);
    expect(contractSet.contracts[0]?.contract_sha256).toBe(
      expected.contractSha256,
    );
  });

  it("recomputes the graph hash and AST bytes", () => {
    expect(run.error_code).toBeNull();
    expect(run.validated?.graph.graph_sha256).toBe(expected.graphSha256);
    expect(run.validated?.graph.canonicalBytes).toBe(expected.astBytes);
  });

  it("quantizes the exact positive tie half-even to 2", () => {
    // 1 USD * 1.5 = 1.5 exactly, the tie at the JPY exponent of zero.
    expect(run.outcome?.state).toBe("succeeded");
    expect(outputRow(run).value).toEqual({
      state: "present",
      type: "decimal",
      value: { coefficient: "2", scale: "i64:0" },
    });
  });

  it("recomputes every meter, result, and output identity", () => {
    const meter = run.outcome?.meter;
    expect(run.outcome?.result_id).toBe(expected.resultId);
    expect(meter?.primitive_steps).toBe(expected.primitiveSteps);
    expect(run.outcome?.intermediateByteVector).toEqual([
      ...expected.intermediateByteVector,
    ]);
    expect(meter?.output_bytes).toBe(expected.outputBytes);
    expect(meter?.logical_allocation_bytes).toBe(
      expected.logicalAllocationBytes,
    );
    expect(run.outcome?.meter_sha256).toBe(expected.meterSha256);
    expect(run.outcome?.result_sha256).toBe(expected.resultSha256);
    expect(run.outcome?.outputEntrySha256.get(CONVERT_NODE_ID)).toBe(
      expected.outputSha256,
    );
  });

  it("recomputes the output-value binding digest", () => {
    const digest = outputValueDigest({
      result_id: expected.resultId,
      node_id: CONVERT_NODE_ID,
      row_id: outputRow(run).row_id,
      field_id: null,
      value: {
        state: "present",
        type: "decimal",
        value: { coefficient: 2n, scale: 0n },
      },
    });
    expect(digest.sha256).toBe(expected.outputValueSha256);
  });
});

describe("fx-jpy-negative-tie", () => {
  const expected = R7_JPY_VECTORS.negative;
  const positive = R7_JPY_VECTORS.positive;
  const fixture = NEGATIVE;
  const run = runFixture(fixture);

  it("changes only the input-dependent identities", () => {
    const input = parseInput(fixture.inputBytes);
    expect(input.input_sha256).toBe(expected.inputSha256);
    expect(input.canonicalBytes).toBe(expected.inputBytes);

    const catalog = parseCatalog(fixture.catalogBytes);
    expect(catalog.catalog_sha256).toBe(expected.catalogSha256);

    // The plan states the evidence, entry, and contract hashes equal the
    // positive vector's; only the source-dependent chain moves.
    expect(rowHash("dasher.fx-rate-evidence.v1", fixture.evidenceBytes)).toBe(
      positive.evidenceSha256,
    );
    const contractSet = parseContracts(fixture.contractSetBytes);
    expect(contractSet.contract_set_sha256).toBe(positive.contractSetSha256);
    expect(contractSet.contracts[0]?.contract_sha256).toBe(
      positive.contractSha256,
    );
    expect(
      rowHash("dasher.common-evidence-bundle.v1", fixture.bundleBytes),
    ).toBe(expected.bundleSha256);
  });

  it("quantizes the exact negative tie half-even to -2", () => {
    // -1 USD * 1.5 = -1.5 exactly: the symmetric tie of the positive vector.
    expect(run.error_code).toBeNull();
    expect(outputRow(run).value).toEqual({
      state: "present",
      type: "decimal",
      value: { coefficient: "-2", scale: "i64:0" },
    });
  });

  it("recomputes every graph, meter, result, and output identity", () => {
    const meter = run.outcome?.meter;
    expect(run.validated?.graph.graph_sha256).toBe(expected.graphSha256);
    expect(run.validated?.graph.canonicalBytes).toBe(expected.astBytes);
    expect(run.outcome?.result_id).toBe(expected.resultId);
    expect(meter?.primitive_steps).toBe(expected.primitiveSteps);
    expect(run.outcome?.intermediateByteVector).toEqual([
      ...expected.intermediateByteVector,
    ]);
    expect(meter?.output_bytes).toBe(expected.outputBytes);
    expect(meter?.logical_allocation_bytes).toBe(
      expected.logicalAllocationBytes,
    );
    expect(run.outcome?.meter_sha256).toBe(expected.meterSha256);
    expect(run.outcome?.result_sha256).toBe(expected.resultSha256);
    expect(run.outcome?.outputEntrySha256.get(CONVERT_NODE_ID)).toBe(
      expected.outputSha256,
    );
  });

  it("recomputes the output-value binding digest", () => {
    const digest = outputValueDigest({
      result_id: expected.resultId,
      node_id: CONVERT_NODE_ID,
      row_id: outputRow(run).row_id,
      field_id: null,
      value: {
        state: "present",
        type: "decimal",
        value: { coefficient: -2n, scale: 0n },
      },
    });
    expect(digest.sha256).toBe(expected.outputValueSha256);
  });
});

describe("the two ties are one boundary", () => {
  it("differs only in the sign of the input amount", () => {
    expect(POSITIVE.rawGraphBytes.length).toBe(NEGATIVE.rawGraphBytes.length);
    expect(POSITIVE.evidenceBytes).toBe(NEGATIVE.evidenceBytes);
    expect(POSITIVE.contractSetBytes).toBe(NEGATIVE.contractSetBytes);
    expect(NEGATIVE.inputBytes).toBe(
      POSITIVE.inputBytes.replace('"coefficient":"1"', '"coefficient":"-1"'),
    );
  });
});
