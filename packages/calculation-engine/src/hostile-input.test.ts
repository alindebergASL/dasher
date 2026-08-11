/**
 * Adversarial input vectors: prototype-bearing keys, inherited operation names,
 * malformed documents, and unbounded declared widths.
 *
 * Every vector here asserts the same two properties — the engine answers with one
 * of the seventeen closed codes, and no host exception with a stack trace reaches
 * the caller.
 */

import { describe, expect, it } from "vitest";

import { jcsEncode, parseStrictJson, rowHash } from "./canonical";
import {
  CalculationFailure,
  ERROR_CODES,
  type ErrorCode,
  canonicalizeDocument,
  parseCalculationGraph,
  parseCanonicalInputTable,
  parseCommonEvidenceBundle,
  parseFieldCatalogSnapshot,
  parseFxRateEvidence,
  parseMetricContractSet,
  runCalculation,
  snapshotRawGraphBytes,
  utf8ByteLength,
  validateCalculation,
} from "./index";
import { OP_FIELDS, isOp } from "./registry";
import {
  R7_BUNDLE_BYTES,
  R7_CATALOG_BYTES,
  R7_CONTRACT_SET_BYTES,
  R7_EVIDENCE_BYTES,
  R7_GRAPH_BYTES,
  R7_INPUT_BYTES,
} from "./r7-fixtures";

const baseRequest = {
  rawGraphBytes: R7_GRAPH_BYTES,
  inputBytes: R7_INPUT_BYTES,
  catalogBytes: R7_CATALOG_BYTES,
  contractSetBytes: R7_CONTRACT_SET_BYTES,
  bundleBytes: R7_BUNDLE_BYTES,
  fxEvidenceBytes: R7_EVIDENCE_BYTES,
};

const CLOSED_CODES: readonly string[] = ERROR_CODES;

/**
 * Inserts a key into one JSON object of a frozen fixture by editing its bytes.
 *
 * The insertion is textual on purpose: `JSON.parse` followed by property
 * assignment would route `__proto__` through the host's own object model before
 * the engine ever sees it, which is not the vector under test.
 */
function insertKeyAfter(
  text: string,
  openingObject: string,
  member: string,
): string {
  const at = text.indexOf(openingObject);
  expect(at).toBeGreaterThanOrEqual(0);
  const insertAt = at + openingObject.length;
  return `${text.slice(0, insertAt)}${member},${text.slice(insertAt)}`;
}

/** Runs one request and returns its closed code, failing on any host exception. */
function codeOf(request: Parameters<typeof runCalculation>[0]): ErrorCode {
  const run = runCalculation(request);
  expect(run.error_code).not.toBeNull();
  expect(CLOSED_CODES).toContain(run.error_code as string);
  return run.error_code as ErrorCode;
}

/* ------------------------------------------------------------------ *
 * `__proto__` at the canonical boundary
 * ------------------------------------------------------------------ */

describe("__proto__ cannot cross the canonical boundary", () => {
  it("keeps a parsed __proto__ key as an own member of a prototype-free object", () => {
    const parsed = parseStrictJson('{"__proto__":{"a":"b"},"c":"d"}');
    const asObject = parsed as unknown as Record<string, unknown>;
    expect(Object.getPrototypeOf(asObject)).toBeNull();
    expect(Object.hasOwn(asObject, "__proto__")).toBe(true);
    expect(Object.keys(asObject)).toEqual(["__proto__", "c"]);
    // The key reaches the canonical bytes instead of vanishing into a prototype.
    expect(jcsEncode(parsed)).toBe('{"__proto__":{"a":"b"},"c":"d"}');
  });

  it("never mutates Object.prototype through a hostile document", () => {
    const probe = {} as Record<string, unknown>;
    parseStrictJson('{"__proto__":{"polluted":"yes"}}');
    canonicalizeDocument(
      JSON.parse('{"__proto__":{"polluted":"yes"}}') as Record<string, unknown>,
    );
    expect(probe.polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(
      (Object.prototype as unknown as Record<string, unknown>).polluted,
    ).toBeUndefined();
  });

  it("gives two documents that differ only in __proto__ distinct canonical hashes", () => {
    // The integrity claim the security review broke: a semantic difference
    // carried by `__proto__` must not encode to the same bytes as its absence.
    const withKey = '{"__proto__":{"state":"stale_fx"},"schema":"x"}';
    const without = '{"schema":"x"}';
    const encodeOf = (text: string): string =>
      jcsEncode(parseStrictJson(text) as never);
    expect(encodeOf(withKey)).not.toBe(encodeOf(without));
    expect(rowHash("dasher.calculation-graph.v1", encodeOf(withKey))).not.toBe(
      rowHash("dasher.calculation-graph.v1", encodeOf(without)),
    );
    expect(encodeOf(withKey)).toContain("__proto__");
  });

  it("rejects __proto__ in every document position with a closed code", () => {
    const positions: ReadonlyArray<readonly [string, () => ErrorCode]> = [
      [
        "graph root",
        () =>
          codeOf({
            ...baseRequest,
            rawGraphBytes: insertKeyAfter(
              R7_GRAPH_BYTES,
              "{",
              '"__proto__":"x"',
            ),
          }),
      ],
      [
        "graph node",
        () =>
          codeOf({
            ...baseRequest,
            rawGraphBytes: insertKeyAfter(
              R7_GRAPH_BYTES,
              '"nodes":[{',
              '"__proto__":"x"',
            ),
          }),
      ],
      [
        "input row",
        () =>
          codeOf({
            ...baseRequest,
            inputBytes: insertKeyAfter(
              R7_INPUT_BYTES,
              '"rows":[{',
              '"__proto__":"x"',
            ),
          }),
      ],
      [
        "input root",
        () =>
          codeOf({
            ...baseRequest,
            inputBytes: insertKeyAfter(R7_INPUT_BYTES, "{", '"__proto__":"x"'),
          }),
      ],
      [
        "catalog entry",
        () =>
          codeOf({
            ...baseRequest,
            catalogBytes: insertKeyAfter(
              R7_CATALOG_BYTES,
              '"fields":[{',
              '"__proto__":"x"',
            ),
          }),
      ],
      [
        "contract",
        () =>
          codeOf({
            ...baseRequest,
            contractSetBytes: insertKeyAfter(
              R7_CONTRACT_SET_BYTES,
              '"contracts":[{',
              '"__proto__":"x"',
            ),
          }),
      ],
      [
        "bundle entry",
        () =>
          codeOf({
            ...baseRequest,
            bundleBytes: insertKeyAfter(
              R7_BUNDLE_BYTES,
              '"entries":[{',
              '"__proto__":"x"',
            ),
          }),
      ],
      [
        "fx evidence",
        () =>
          codeOf({
            ...baseRequest,
            fxEvidenceBytes: insertKeyAfter(
              R7_EVIDENCE_BYTES,
              "{",
              '"__proto__":"x"',
            ),
          }),
      ],
    ];
    for (const [position, run] of positions) {
      expect([position, run()]).toEqual([position, "invalid_graph"]);
    }
  });

  it("rejects every other inherited member name as a document key", () => {
    for (const inherited of [
      "constructor",
      "toString",
      "valueOf",
      "hasOwnProperty",
      "isPrototypeOf",
      "propertyIsEnumerable",
      "toLocaleString",
    ]) {
      expect(
        codeOf({
          ...baseRequest,
          rawGraphBytes: insertKeyAfter(
            R7_GRAPH_BYTES,
            "{",
            `"${inherited}":"x"`,
          ),
        }),
      ).toBe("invalid_graph");
    }
  });

  it("still rejects a graph whose required key is only inherited", () => {
    // `Object.hasOwn`, not `in`: `toString` is never a supplied `schema`.
    const withoutSchema = R7_GRAPH_BYTES.replace(
      '"schema":"calculation-graph-v1",',
      "",
    );
    expect(withoutSchema).not.toBe(R7_GRAPH_BYTES);
    expect(codeOf({ ...baseRequest, rawGraphBytes: withoutSchema })).toBe(
      "invalid_graph",
    );
  });
});

/* ------------------------------------------------------------------ *
 * The operation registry is own-property membership
 * ------------------------------------------------------------------ */

describe("operation registry membership", () => {
  const INHERITED = [
    "toString",
    "valueOf",
    "constructor",
    "__proto__",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
  ] as const;

  it("admits no inherited Object.prototype member as an operation", () => {
    for (const name of INHERITED) {
      expect(isOp(name)).toBe(false);
      expect(Object.hasOwn(OP_FIELDS, name)).toBe(false);
    }
    expect(isOp("source")).toBe(true);
  });

  it("denies each inherited name used as a node op with a closed code", () => {
    for (const name of INHERITED) {
      const graphBytes = R7_GRAPH_BYTES.replace(
        '"op":"source"',
        `"op":"${name}"`,
      );
      expect(graphBytes).not.toBe(R7_GRAPH_BYTES);
      expect(codeOf({ ...baseRequest, rawGraphBytes: graphBytes })).toBe(
        "invalid_graph",
      );
    }
  });
});

/* ------------------------------------------------------------------ *
 * The error channel is closed
 * ------------------------------------------------------------------ */

describe("closed error channel", () => {
  const MALFORMED: ReadonlyArray<readonly [string, string]> = [
    ["empty document", ""],
    ["truncated object", '{"schema":'],
    ["unterminated string", '{"schema":"calculation'],
    ["array root", "[]"],
    ["bare string root", '"calculation-graph-v1"'],
    ["JSON number token", '{"schema":"calculation-graph-v1","nodes":1}'],
    ["duplicate key", '{"schema":"a","schema":"b"}'],
    ["trailing content", '{"schema":"a"} {"schema":"b"}'],
    ["literal control character", '{"schema":"a"}'],
    ["invalid escape", '{"schema":"\\q"}'],
    ["truncated unicode escape", '{"schema":"\\u00"}'],
    ["unpaired surrogate", '{"schema":"\\ud800"}'],
    ["non-NFC key", '{"Å":"x"}'],
    ["single-quoted key", "{'schema':'a'}"],
  ];

  it("maps every malformed graph to a closed code with no host exception", () => {
    for (const [name, text] of MALFORMED) {
      const run = runCalculation({ ...baseRequest, rawGraphBytes: text });
      expect([name, run.error_code]).toEqual([name, "invalid_graph"]);
      expect([name, run.outcome]).toEqual([name, null]);
      expect([name, run.validated]).toEqual([name, null]);
    }
  });

  it("maps every malformed companion document to a closed code", () => {
    for (const [name, text] of MALFORMED) {
      for (const key of [
        "inputBytes",
        "catalogBytes",
        "contractSetBytes",
        "bundleBytes",
        "fxEvidenceBytes",
      ] as const) {
        const run = runCalculation({ ...baseRequest, [key]: text });
        expect([name, key, run.error_code]).toEqual([
          name,
          key,
          "invalid_graph",
        ]);
      }
    }
  });

  it("throws only CalculationFailure from validateCalculation", () => {
    for (const [name, text] of MALFORMED) {
      try {
        validateCalculation({ ...baseRequest, rawGraphBytes: text });
        throw new Error(`expected a closed failure for ${name}`);
      } catch (error) {
        expect([name, error instanceof CalculationFailure]).toEqual([
          name,
          true,
        ]);
        const failure = error as CalculationFailure;
        expect(CLOSED_CODES).toContain(failure.code);
        // No absolute path, module name, or parser offset in the detail text.
        expect(failure.detail).not.toMatch(/\/|offset|\.ts/);
      }
    }
  });

  it("maps the raw and canonical byte ceilings to limit_exceeded", () => {
    const overRaw = `{"a":"${"x".repeat(131072 - 7)}"}`;
    expect(utf8ByteLength(overRaw)).toBeGreaterThan(131072n);
    expect(codeOf({ ...baseRequest, rawGraphBytes: overRaw })).toBe(
      "limit_exceeded",
    );
    const overCanonical = `{  "a" : "${"x".repeat(65536 - 7)}" }`;
    expect(utf8ByteLength(overCanonical)).toBeLessThanOrEqual(131072n);
    expect(codeOf({ ...baseRequest, rawGraphBytes: overCanonical })).toBe(
      "limit_exceeded",
    );
    expect(() => snapshotRawGraphBytes(overRaw)).toThrow(CalculationFailure);
  });

  it("closes every exported parser that reads an untrusted document", () => {
    const parsers = [
      parseCalculationGraph,
      parseCanonicalInputTable,
      parseCommonEvidenceBundle,
      parseFieldCatalogSnapshot,
      parseFxRateEvidence,
      parseMetricContractSet,
    ] as const;
    for (const parser of parsers) {
      expect(() =>
        (parser as (value: unknown, text: string) => unknown)(
          "not an object",
          "not an object",
        ),
      ).toThrow(CalculationFailure);
    }
    expect(() => canonicalizeDocument(new Date(0) as never)).toThrow(
      CalculationFailure,
    );
  });
});

/* ------------------------------------------------------------------ *
 * Declared widths are bounded before any allocation
 * ------------------------------------------------------------------ */

describe("declared max_value_bytes", () => {
  /**
   * Rewrites the integer field width in both the catalog and the graph, then
   * rebinds the graph's catalog digest so the vector reaches the meters instead
   * of failing the earlier snapshot-binding check.
   */
  function withKeyWidth(width: string): typeof baseRequest {
    const from = '"max_value_bytes":"i64:26"';
    const to = `"max_value_bytes":"i64:${width}"`;
    const catalogBytes = R7_CATALOG_BYTES.split(from).join(to);
    const catalogSha = rowHash(
      "dasher.field-catalog-snapshot.v1",
      catalogBytes,
    );
    const rawGraphBytes = R7_GRAPH_BYTES.split(from)
      .join(to)
      .replace(
        /"field_catalog_sha256":"[0-9a-f]{64}"/,
        `"field_catalog_sha256":"${catalogSha}"`,
      );
    expect(catalogBytes).not.toBe(R7_CATALOG_BYTES);
    expect(rawGraphBytes).not.toBe(R7_GRAPH_BYTES);
    return { ...baseRequest, catalogBytes, rawGraphBytes };
  }

  it("denies the maximum tagged i64 width deterministically", () => {
    expect(codeOf(withKeyWidth("9223372036854775807"))).toBe("limit_exceeded");
  });

  it("denies a width one byte over the limits ceiling", () => {
    expect(codeOf(withKeyWidth("8388609"))).toBe("limit_exceeded");
  });

  it("admits a width at the limits ceiling through the width gate", () => {
    // At the ceiling the width itself is admissible, so the denial comes from a
    // byte meter rather than the pre-allocation gate.
    try {
      validateCalculation(withKeyWidth("8388608"));
      throw new Error("expected a limits denial");
    } catch (error) {
      expect(error).toBeInstanceOf(CalculationFailure);
      const failure = error as CalculationFailure;
      expect(failure.code).toBe("limit_exceeded");
      expect(failure.detail).not.toContain("declared max_value_bytes");
    }
  });

  it("answers a width no filler string could encode without a host error", () => {
    // A one-byte declared width made `"x".repeat(Number(width) - 2)` raise a
    // host RangeError. Arithmetic byte accounting answers it like any other
    // width: a result, or a closed code, never an exception.
    const run = runCalculation(withKeyWidth("1"));
    if (run.error_code !== null) {
      expect(CLOSED_CODES).toContain(run.error_code);
    } else {
      expect(run.outcome?.state).toBe("succeeded");
    }
  });

  it("never allocates from an untrusted width", () => {
    // A precision-losing `Number()` conversion or a filler allocation of this
    // size would raise a host error long before any meter could answer.
    for (const width of [
      "9223372036854775807",
      "9007199254740993",
      "1000000000000",
    ]) {
      expect(codeOf(withKeyWidth(width))).toBe("limit_exceeded");
    }
  });

  it("leaves the frozen fixture's own widths admissible", () => {
    expect(runCalculation(baseRequest).error_code).toBeNull();
  });
});
