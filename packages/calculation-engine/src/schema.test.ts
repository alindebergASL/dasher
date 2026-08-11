import { describe, expect, it } from "vitest";

import { jcsEncode, parseStrictJson, rowHash } from "./canonical";
import {
  CalculationFailure,
  ERROR_CODES,
  canonicalizeDocument,
  encodeTypedValue,
  outputTypesEqual,
  parseCalculationGraph,
  parseCanonicalInputTable,
  parseCommonEvidenceBundle,
  parseContractDecimalText,
  parseFieldCatalogSnapshot,
  parseFxRateEvidence,
  parseMetricContractSet,
  parseOutputType,
  parseTypedValue,
  referencedNodeIds,
} from "./schema";
import {
  R7_BUNDLE_BYTES,
  R7_CATALOG_BYTES,
  R7_CONTRACT_SET_BYTES,
  R7_EVIDENCE_BYTES,
  R7_GRAPH_BYTES,
  R7_IDENTITIES,
  R7_INPUT_BYTES,
} from "./r7-fixtures";

function parseDocument(text: string): {
  value: ReturnType<typeof parseStrictJson>;
  canonicalText: string;
} {
  const value = parseStrictJson(text);
  return { value, canonicalText: jcsEncode(value) };
}

function expectFailure(code: string, run: () => unknown): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(CalculationFailure);
    expect((error as CalculationFailure).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

/** Mutates one path of a parsed document and re-encodes it canonically. */
function mutateGraph(mutate: (graph: Record<string, unknown>) => void): {
  value: ReturnType<typeof parseStrictJson>;
  canonicalText: string;
} {
  const graph = JSON.parse(R7_GRAPH_BYTES) as Record<string, unknown>;
  mutate(graph);
  return canonicalizeDocument(graph);
}

describe("closed semantic error codes", () => {
  it("holds exactly the seventeen closed codes", () => {
    expect([...ERROR_CODES]).toEqual([
      "invalid_graph",
      "type_mismatch",
      "unit_mismatch",
      "currency_mismatch",
      "grain_mismatch",
      "missing_field",
      "cycle",
      "limit_exceeded",
      "overflow",
      "divide_by_zero",
      "empty_input",
      "invalid_timezone",
      "invalid_unit_conversion",
      "inexact_arithmetic",
      "missing_fx_evidence",
      "stale_fx",
      "invalid_group_key",
    ]);
    expect(ERROR_CODES).not.toContain("calculation_timeout");
    expect(ERROR_CODES).not.toContain("calculation_resource_exhausted");
  });
});

describe("R7 fixture parsing", () => {
  it("parses the canonical input and recomputes its exact hash and bytes", () => {
    const document = parseDocument(R7_INPUT_BYTES);
    expect(document.canonicalText).toBe(R7_INPUT_BYTES);
    const table = parseCanonicalInputTable(
      document.value,
      document.canonicalText,
    );
    expect(table.input_sha256).toBe(R7_IDENTITIES.inputSha256);
    expect(table.canonicalBytes).toBe(R7_IDENTITIES.inputBytes);
    expect(table.row_count).toBe(1n);
    expect(table.rows[0]?.row_id).toBe(R7_IDENTITIES.sourceRowId);
    expect(table.fields.map((field) => field.scalar_type)).toEqual([
      "integer",
      "decimal",
      "timestamp",
    ]);
  });

  it("parses the graph and recomputes its exact hash and AST bytes", () => {
    const document = parseDocument(R7_GRAPH_BYTES);
    expect(document.canonicalText).toBe(R7_GRAPH_BYTES);
    const graph = parseCalculationGraph(document.value, document.canonicalText);
    expect(graph.graph_sha256).toBe(R7_IDENTITIES.graphSha256);
    expect(graph.canonicalBytes).toBe(R7_IDENTITIES.astBytes);
    expect(graph.nodes).toHaveLength(5);
    expect(graph.output_node_ids).toEqual([
      "00000000-0000-8000-8000-000000000305",
    ]);
    expect(graph.threshold_node_id).toBeNull();
    expect(graph.target_node_id).toBeNull();
    expect(graph.fx_evidence_id).toBe("00000000-0000-8000-8000-000000000106");
  });

  it("parses the catalog and recomputes every entry hash", () => {
    const document = parseDocument(R7_CATALOG_BYTES);
    const catalog = parseFieldCatalogSnapshot(
      document.value,
      document.canonicalText,
    );
    expect(catalog.catalog_sha256).toBe(R7_IDENTITIES.catalogSha256);
    expect(catalog.fields.map((field) => field.entry_sha256)).toEqual([
      ...R7_IDENTITIES.catalogEntrySha256,
    ]);
  });

  it("parses the contract set and recomputes the set and entry hashes", () => {
    const document = parseDocument(R7_CONTRACT_SET_BYTES);
    const set = parseMetricContractSet(document.value, document.canonicalText);
    expect(set.contract_set_sha256).toBe(R7_IDENTITIES.contractSetSha256);
    expect(set.contracts[0]?.contract_sha256).toBe(
      R7_IDENTITIES.contractSha256,
    );
    expect(set.contracts[0]?.grain).toBe(R7_IDENTITIES.groupGrain);
  });

  it("parses the bundle and the typed-value FX evidence body", () => {
    const bundleDocument = parseDocument(R7_BUNDLE_BYTES);
    const bundle = parseCommonEvidenceBundle(
      bundleDocument.value,
      bundleDocument.canonicalText,
    );
    expect(bundle.bundle_sha256).toBe(R7_IDENTITIES.bundleSha256);
    expect(bundle.entries[0]?.evidence_sha256).toBe(
      R7_IDENTITIES.evidenceSha256,
    );

    const evidenceDocument = parseDocument(R7_EVIDENCE_BYTES);
    const evidence = parseFxRateEvidence(
      evidenceDocument.value,
      evidenceDocument.canonicalText,
    );
    expect(evidence.evidence_sha256).toBe(R7_IDENTITIES.evidenceSha256);
    expect(evidence.coordinates).toBe("task9-fx:USD/EUR");
    expect(evidence.rate).toEqual({ coefficient: 925n, scale: 3n });
  });

  it("changes the digest when a single fixture bit changes", () => {
    const mutated = R7_EVIDENCE_BYTES.replace('"925"', '"926"');
    expect(rowHash("dasher.fx-rate-evidence.v1", mutated)).not.toBe(
      R7_IDENTITIES.evidenceSha256,
    );
  });
});

describe("strict graph schema", () => {
  const parse = (document: {
    value: ReturnType<typeof parseStrictJson>;
    canonicalText: string;
  }): unknown => parseCalculationGraph(document.value, document.canonicalText);

  it("rejects an unknown top-level key", () => {
    expectFailure("invalid_graph", () =>
      parse(
        mutateGraph((graph) => {
          graph.extra_key = null;
        }),
      ),
    );
  });

  it("rejects a missing top-level key", () => {
    expectFailure("invalid_graph", () =>
      parse(
        mutateGraph((graph) => {
          delete graph.timezone;
        }),
      ),
    );
  });

  it("rejects a drifted schema, registry, or limits version", () => {
    for (const key of ["schema", "registry", "limits"] as const) {
      expectFailure("invalid_graph", () =>
        parse(
          mutateGraph((graph) => {
            graph[key] = "calculation-graph-v2";
          }),
        ),
      );
    }
  });

  it("rejects a non-pinned tzdb release", () => {
    expectFailure("invalid_timezone", () =>
      parse(
        mutateGraph((graph) => {
          graph.tzdb_version = "2025a";
        }),
      ),
    );
  });

  it("rejects an unknown unit registry version", () => {
    expectFailure("invalid_graph", () =>
      parse(
        mutateGraph((graph) => {
          graph.unit_registry_version = "ucum";
        }),
      ),
    );
  });

  it("rejects an unknown op and every alias spelling", () => {
    for (const alias of ["project", "map", "percent_change", "aggregate"]) {
      expectFailure("invalid_graph", () =>
        parse(
          mutateGraph((graph) => {
            const nodes = graph.nodes as Record<string, unknown>[];
            (nodes[1] as Record<string, unknown>).op = alias;
          }),
        ),
      );
    }
  });

  it("rejects an unknown op-specific key", () => {
    expectFailure("invalid_graph", () =>
      parse(
        mutateGraph((graph) => {
          const nodes = graph.nodes as Record<string, unknown>[];
          (nodes[4] as Record<string, unknown>).frame_kind = "event_time";
        }),
      ),
    );
  });

  it("rejects every rejected temporal window key", () => {
    for (const key of [
      "frame_kind",
      "event_time",
      "duration_millis",
      "period",
      "calendar",
    ]) {
      expectFailure("invalid_graph", () =>
        parse(
          mutateGraph((graph) => {
            const nodes = graph.nodes as Record<string, unknown>[];
            (nodes[3] as Record<string, unknown>)[key] = "x";
          }),
        ),
      );
    }
  });

  it("rejects a JSON number token anywhere in the raw document", () => {
    expect(() =>
      parseStrictJson(R7_GRAPH_BYTES.replace('"i64:1"', "1")),
    ).toThrow(/number/i);
  });

  it("rejects a noncanonical tagged i64", () => {
    expectFailure("invalid_graph", () =>
      parse(
        mutateGraph((graph) => {
          graph.contract_version = "i64:01";
        }),
      ),
    );
  });

  it("requires a rowset node to carry a null evaluation domain", () => {
    expectFailure("invalid_graph", () =>
      parse(
        mutateGraph((graph) => {
          const nodes = graph.nodes as Record<string, unknown>[];
          (nodes[0] as Record<string, unknown>).evaluation_rows_from =
            "00000000-0000-8000-8000-000000000301";
        }),
      ),
    );
  });

  it("requires a scalar node to name its evaluation domain", () => {
    expectFailure("invalid_graph", () =>
      parse(
        mutateGraph((graph) => {
          const nodes = graph.nodes as Record<string, unknown>[];
          (nodes[1] as Record<string, unknown>).evaluation_rows_from = null;
        }),
      ),
    );
  });

  it("rejects unsorted or duplicated output node IDs", () => {
    expectFailure("invalid_graph", () =>
      parse(
        mutateGraph((graph) => {
          graph.output_node_ids = [
            "00000000-0000-8000-8000-000000000305",
            "00000000-0000-8000-8000-000000000305",
          ];
        }),
      ),
    );
  });

  it("rejects an FX ID without its SHA", () => {
    expectFailure("invalid_graph", () =>
      parse(
        mutateGraph((graph) => {
          graph.fx_evidence_sha256 = null;
        }),
      ),
    );
  });

  it("rejects a nonpositive or overlong currency-convert rate", () => {
    for (const rate of [
      { coefficient: "0", scale: "i64:0" },
      { coefficient: "-1", scale: "i64:0" },
      { coefficient: "1".repeat(19), scale: "i64:0" },
    ]) {
      expectFailure("invalid_graph", () =>
        parse(
          mutateGraph((graph) => {
            const nodes = graph.nodes as Record<string, unknown>[];
            (nodes[4] as Record<string, unknown>).rate = rate;
          }),
        ),
      );
    }
  });

  it("rejects scale i64:-1 and i64:19 while accepting i64:0 and i64:18", () => {
    for (const scale of ["i64:-1", "i64:19"]) {
      expectFailure("invalid_graph", () =>
        parse(
          mutateGraph((graph) => {
            const nodes = graph.nodes as Record<string, unknown>[];
            (nodes[4] as Record<string, unknown>).scale = scale;
          }),
        ),
      );
    }
    for (const scale of ["i64:0", "i64:18"]) {
      expect(() =>
        parse(
          mutateGraph((graph) => {
            const nodes = graph.nodes as Record<string, unknown>[];
            (nodes[4] as Record<string, unknown>).scale = scale;
          }),
        ),
      ).not.toThrow();
    }
  });

  it("rejects an unknown unit or currency literal in a node or output type", () => {
    expectFailure("unit_mismatch", () =>
      parseOutputType(
        parseStrictJson(
          '{"shape":"scalar","scalar":"decimal","nullable":false,"unit":"ft","currency":null,"grain":null,"max_value_bytes":"i64:74","fields":null}',
        ),
        "t",
      ),
    );
    expectFailure("currency_mismatch", () =>
      parseOutputType(
        parseStrictJson(
          '{"shape":"scalar","scalar":"decimal","nullable":false,"unit":null,"currency":"CHF","grain":null,"max_value_bytes":"i64:74","fields":null}',
        ),
        "t",
      ),
    );
  });

  it("rejects a scalar that carries both a unit and a currency", () => {
    expectFailure("unit_mismatch", () =>
      parseOutputType(
        parseStrictJson(
          '{"shape":"scalar","scalar":"decimal","nullable":false,"unit":"m","currency":"USD","grain":null,"max_value_bytes":"i64:74","fields":null}',
        ),
        "t",
      ),
    );
  });

  it("rejects dimensional nonsense such as a timestamp currency or boolean metres", () => {
    expectFailure("currency_mismatch", () =>
      parseOutputType(
        parseStrictJson(
          '{"shape":"scalar","scalar":"timestamp","nullable":false,"unit":null,"currency":"USD","grain":null,"max_value_bytes":"i64:29","fields":null}',
        ),
        "t",
      ),
    );
    expectFailure("unit_mismatch", () =>
      parseOutputType(
        parseStrictJson(
          '{"shape":"scalar","scalar":"boolean","nullable":false,"unit":"m","currency":null,"grain":null,"max_value_bytes":"i64:5","fields":null}',
        ),
        "t",
      ),
    );
  });

  it("requires the six rowset scalar attributes to be null", () => {
    expectFailure("type_mismatch", () =>
      parseOutputType(
        parseStrictJson(
          '{"shape":"rowset","scalar":"decimal","nullable":null,"unit":null,"currency":null,"grain":null,"max_value_bytes":null,"fields":[]}',
        ),
        "t",
      ),
    );
  });

  it("compares output types byte-exactly", () => {
    const text =
      '{"shape":"scalar","scalar":"decimal","nullable":false,"unit":null,"currency":"USD","grain":null,"max_value_bytes":"i64:74","fields":null}';
    const left = parseOutputType(parseStrictJson(text), "t");
    const right = parseOutputType(parseStrictJson(text), "t");
    expect(outputTypesEqual(left, right)).toBe(true);
    const other = parseOutputType(
      parseStrictJson(text.replace('"USD"', '"EUR"')),
      "t",
    );
    expect(outputTypesEqual(left, other)).toBe(false);
  });

  it("collects every referenced node ID", () => {
    const document = parseDocument(R7_GRAPH_BYTES);
    const graph = parseCalculationGraph(document.value, document.canonicalText);
    const sum = graph.nodes.find((node) => node.op === "sum");
    expect([...referencedNodeIds(sum as never)].sort()).toEqual([
      "00000000-0000-8000-8000-000000000302",
      "00000000-0000-8000-8000-000000000303",
      "00000000-0000-8000-8000-000000000303",
    ]);
  });
});

describe("tagged literal values", () => {
  it("requires a JSON null value for every non-present state", () => {
    for (const state of ["null", "missing", "unavailable"]) {
      expect(
        parseTypedValue(
          parseStrictJson(`{"state":"${state}","type":"integer","value":null}`),
          "v",
        ),
      ).toEqual({ state, type: "integer", value: null });
      expectFailure("invalid_graph", () =>
        parseTypedValue(
          parseStrictJson(
            `{"state":"${state}","type":"integer","value":"i64:1"}`,
          ),
          "v",
        ),
      );
    }
  });

  it("rejects the runtime-only stale state in a graph literal", () => {
    expectFailure("invalid_graph", () =>
      parseTypedValue(
        parseStrictJson('{"state":"stale","type":"integer","value":"i64:1"}'),
        "v",
      ),
    );
    expect(
      parseTypedValue(
        parseStrictJson('{"state":"stale","type":"integer","value":"i64:1"}'),
        "v",
        { allowStale: true },
      ).state,
    ).toBe("stale");
  });

  it("round-trips every scalar payload through canonical bytes", () => {
    const samples = [
      '{"state":"present","type":"boolean","value":true}',
      '{"state":"present","type":"integer","value":"i64:-9223372036854775808"}',
      '{"state":"present","type":"decimal","value":{"coefficient":"925","scale":"i64:1"}}',
      '{"state":"present","type":"text","value":"café"}',
      '{"state":"present","type":"date","value":"2026-08-04"}',
      '{"state":"present","type":"timestamp","value":"2026-08-04T12:00:00.000000Z"}',
      '{"state":"present","type":"duration","value":"i64:86400000000"}',
    ];
    for (const sample of samples) {
      const parsed = parseTypedValue(parseStrictJson(sample), "v");
      expect(jcsEncode(encodeTypedValue(parsed))).toBe(sample);
    }
  });

  it("rejects an unreduced decimal spelling in a literal", () => {
    expectFailure("invalid_graph", () =>
      parseTypedValue(
        parseStrictJson(
          '{"state":"present","type":"decimal","value":{"coefficient":"10000","scale":"i64:2"}}',
        ),
        "v",
      ),
    );
  });
});

describe("contract decimal text grammar", () => {
  it("accepts the exact grammar and parses to a reduced rational", () => {
    expect(parseContractDecimalText("0", "t").value).toEqual({ n: 0n, d: 1n });
    expect(parseContractDecimalText("-12.5", "t").value).toEqual({
      n: -25n,
      d: 2n,
    });
    expect(parseContractDecimalText("12.5", "t").scale).toBe(1n);
  });

  it("rejects negative zero, leading zeroes, and trailing fractional zeroes", () => {
    for (const text of ["-0", "01", "1.50", "1.", ".5", "+1", "1e3", ""]) {
      expectFailure("invalid_graph", () => parseContractDecimalText(text, "t"));
    }
  });

  it("rejects more than eighteen fractional digits", () => {
    expectFailure("invalid_graph", () =>
      parseContractDecimalText(`0.${"1".repeat(19)}`, "t"),
    );
    expect(() =>
      parseContractDecimalText(`0.${"1".repeat(18)}`, "t"),
    ).not.toThrow();
  });
});

describe("canonical input strictness", () => {
  const mutateInput = (
    mutate: (input: Record<string, unknown>) => void,
  ): ReturnType<typeof canonicalizeDocument> => {
    const input = JSON.parse(R7_INPUT_BYTES) as Record<string, unknown>;
    mutate(input);
    return canonicalizeDocument(input);
  };

  it("rejects a row count that disagrees with rows.length", () => {
    expectFailure("invalid_graph", () => {
      const document = mutateInput((input) => {
        input.row_count = "i64:2";
      });
      parseCanonicalInputTable(document.value, document.canonicalText);
    });
  });

  it("rejects a cell whose type differs from the field scalar type", () => {
    expectFailure("invalid_graph", () => {
      const document = mutateInput((input) => {
        const rows = input.rows as Record<string, unknown>[];
        const values = (rows[0] as Record<string, unknown>).values as Record<
          string,
          unknown
        >[];
        (values[0] as Record<string, unknown>).type = "decimal";
      });
      parseCanonicalInputTable(document.value, document.canonicalText);
    });
  });

  it("rejects a non-present stable-key value", () => {
    expectFailure("invalid_graph", () => {
      const document = mutateInput((input) => {
        const rows = input.rows as Record<string, unknown>[];
        const values = (rows[0] as Record<string, unknown>).values as Record<
          string,
          unknown
        >[];
        const cell = values[0] as Record<string, unknown>;
        cell.state = "missing";
        cell.value = null;
      });
      parseCanonicalInputTable(document.value, document.canonicalText);
    });
  });

  it("rejects a duration scalar type, which canonical input does not admit", () => {
    expectFailure("invalid_graph", () => {
      const document = mutateInput((input) => {
        const fields = input.fields as Record<string, unknown>[];
        (fields[0] as Record<string, unknown>).scalar_type = "duration";
      });
      parseCanonicalInputTable(document.value, document.canonicalText);
    });
  });

  it("rejects stable key ordinals that are not exactly i64:0..i64:k-1", () => {
    expectFailure("invalid_graph", () => {
      const document = mutateInput((input) => {
        const fields = input.fields as Record<string, unknown>[];
        (fields[0] as Record<string, unknown>).stable_key_ordinal = "i64:1";
      });
      parseCanonicalInputTable(document.value, document.canonicalText);
    });
  });
});
