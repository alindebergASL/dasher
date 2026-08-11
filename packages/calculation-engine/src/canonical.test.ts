import { describe, expect, it } from "vitest";

import {
  CANONICAL_AST_BYTE_CEILING,
  RAW_GRAPH_BYTE_CEILING,
  canonicalBinaryI64,
  canonicalBinaryShaBytes,
  canonicalBinaryText,
  canonicalBinaryUuid,
  civilFromDays,
  daysFromCivil,
  jcsEncode,
  jcsStringTokenBytes,
  parseDateText,
  parseStrictJson,
  parseTimestampMicros,
  rowHash,
  sha256Hex,
  snapshotRawGraphBytes,
  snapshotUntrusted,
  utf8ByteLength,
  uuidV8,
} from "./canonical";
import { R7_EVIDENCE_BYTES, R7_IDENTITIES } from "./r7-fixtures";

describe("strict JSON parsing", () => {
  it("parses only the closed value space", () => {
    expect(parseStrictJson('{"a":["x",true,null]}')).toEqual({
      a: ["x", true, null],
    });
  });

  it("rejects every JSON number token", () => {
    for (const text of ["1", "-1", "1.5", "1e3", '{"a":0}', "[1]"]) {
      expect(() => parseStrictJson(text)).toThrow(/number/i);
    }
  });

  it("rejects duplicate keys", () => {
    expect(() => parseStrictJson('{"a":"1","a":"2"}')).toThrow(/duplicate/i);
  });

  it("rejects literal control characters inside strings but accepts escapes", () => {
    expect(() => parseStrictJson('"a\u0001b"')).toThrow(/control/i);
    expect(parseStrictJson('"a\\u0001b"')).toBe("a\u0001b");
    expect(parseStrictJson('"a\\tb"')).toBe("a\tb");
  });

  it("rejects unpaired surrogates", () => {
    expect(() => parseStrictJson('"\\ud800"')).toThrow(/surrogate/i);
    expect(() => parseStrictJson('"\\udc00x"')).toThrow(/surrogate/i);
    expect(parseStrictJson('"\\ud83d\\ude00"')).toBe("\u{1f600}");
  });

  it("rejects non-NFC strings", () => {
    expect(() => parseStrictJson('"A\u030a"')).toThrow(/nfc/i);
    expect(parseStrictJson('"\u00c5"')).toBe("\u00c5");
  });

  it("rejects trailing content and truncated documents", () => {
    expect(() => parseStrictJson('"a" "b"')).toThrow();
    expect(() => parseStrictJson('{"a":')).toThrow();
    expect(() => parseStrictJson("")).toThrow();
  });
});

describe("JCS encoding", () => {
  it("sorts object keys by UTF-16 code unit order", () => {
    expect(jcsEncode({ b: "1", A: "2", a: "3" })).toBe(
      '{"A":"2","a":"3","b":"1"}',
    );
  });

  it("is stable across caller key order and nesting", () => {
    const first = jcsEncode({ z: { y: "1", x: "2" }, a: ["1", "2"] });
    const second = jcsEncode({ a: ["1", "2"], z: { x: "2", y: "1" } });
    expect(first).toBe(second);
  });

  it("escapes only the JCS-required characters", () => {
    expect(jcsEncode('a"b\\c\u0000\u001f\n\t')).toBe(
      '"a\\"b\\\\c\\u0000\\u001f\\n\\t"',
    );
  });

  it("measures a text token including quotes and escapes", () => {
    expect(jcsStringTokenBytes("ab")).toBe(4n);
    expect(jcsStringTokenBytes('a"b')).toBe(6n);
    expect(jcsStringTokenBytes("\u00e9")).toBe(4n);
    expect(jcsStringTokenBytes("\u{1f600}")).toBe(6n);
  });

  it("measures UTF-8 length of multibyte text", () => {
    expect(utf8ByteLength("a")).toBe(1n);
    expect(utf8ByteLength("\u00e9")).toBe(2n);
    expect(utf8ByteLength("\u20ac")).toBe(3n);
    expect(utf8ByteLength("\u{1f600}")).toBe(4n);
  });
});

describe("hostile snapshot boundary", () => {
  it("reads a hostile getter exactly once", () => {
    let reads = 0;
    const hostile = {
      get value(): string {
        reads += 1;
        return reads === 1 ? "first" : "second";
      },
    };
    const snapshot = snapshotUntrusted(hostile);
    expect(reads).toBe(1);
    expect(jcsEncode(snapshot)).toBe('{"value":"first"}');
    expect(jcsEncode(snapshot)).toBe('{"value":"first"}');
    expect(reads).toBe(1);
  });

  it("never rereads a proxy after the snapshot", () => {
    let reads = 0;
    const hostile = new Proxy(
      { a: "seed" },
      {
        get(target, key, receiver) {
          if (key === "a") {
            reads += 1;
            return `read-${reads}`;
          }
          return Reflect.get(target, key, receiver);
        },
      },
    );
    const snapshot = snapshotUntrusted({ node: hostile });
    expect(reads).toBe(1);
    expect(jcsEncode(snapshot)).toBe('{"node":{"a":"read-1"}}');
    expect(jcsEncode(snapshot)).toBe('{"node":{"a":"read-1"}}');
    expect(reads).toBe(1);
  });

  it("freezes the snapshot so a later caller mutation cannot change bytes", () => {
    const source: Record<string, unknown> = { a: "1" };
    const snapshot = snapshotUntrusted(source);
    const mutable = snapshot as Record<string, unknown>;
    source.a = "2";
    expect(() => {
      mutable.a = "3";
    }).toThrow();
    expect(jcsEncode(snapshot)).toBe('{"a":"1"}');
  });

  it("rejects numbers, undefined, functions, and exotic prototypes", () => {
    expect(() => snapshotUntrusted({ a: 1 })).toThrow(/number/i);
    expect(() => snapshotUntrusted({ a: undefined })).toThrow();
    expect(() => snapshotUntrusted({ a: () => "x" })).toThrow();
    expect(() => snapshotUntrusted(new Date(0))).toThrow();
    expect(() => snapshotUntrusted({ a: 1n })).toThrow();
    expect(() => snapshotUntrusted(new Map())).toThrow(/prototype/i);
    class Exotic {}
    expect(() => snapshotUntrusted(new Exotic())).toThrow(/prototype/i);
  });

  it("snapshots a prototype-free object, the shape the parser produces", () => {
    const source = Object.create(null) as Record<string, unknown>;
    source.b = "2";
    source.a = "1";
    expect(jcsEncode(snapshotUntrusted(source))).toBe('{"a":"1","b":"2"}');
  });

  it("rejects non-NFC strings and unpaired surrogates in snapshotted values", () => {
    expect(() => snapshotUntrusted({ a: "A\u030a" })).toThrow(/nfc/i);
    expect(() => snapshotUntrusted({ a: "\ud800" })).toThrow(/surrogate/i);
  });
});

describe("distinct raw and canonical ceilings", () => {
  const pad = (bytes: number): string => {
    const overhead = utf8ByteLength('{"a":""}');
    return `{"a":"${"x".repeat(bytes - Number(overhead))}"}`;
  };

  it("uses the two distinct inclusive ceilings in order", () => {
    expect(RAW_GRAPH_BYTE_CEILING).toBe(131072n);
    expect(CANONICAL_AST_BYTE_CEILING).toBe(65536n);
  });

  it("accepts raw bytes at the pre-parse ceiling and rejects one over", () => {
    const atCeiling = `{"a":"${"x".repeat(131072 - 8)}"}`;
    expect(utf8ByteLength(atCeiling)).toBe(RAW_GRAPH_BYTE_CEILING);
    expect(() => snapshotRawGraphBytes(atCeiling)).toThrow(/canonical/i);
    const overCeiling = `{"a":"${"x".repeat(131072 - 7)}"}`;
    expect(() => snapshotRawGraphBytes(overCeiling)).toThrow(/raw/i);
  });

  it("accepts canonical bytes at the post-parse ceiling and rejects one over", () => {
    const atCeiling = snapshotRawGraphBytes(pad(65536));
    expect(atCeiling.canonicalBytes).toBe(CANONICAL_AST_BYTE_CEILING);
    expect(() => snapshotRawGraphBytes(pad(65537))).toThrow(/canonical/i);
  });

  it("meters only the canonical bytes, not the raw snapshot", () => {
    const raw = '{  "b" : "2" ,\n  "a" : "1" }';
    const snapshot = snapshotRawGraphBytes(raw);
    expect(snapshot.canonicalText).toBe('{"a":"1","b":"2"}');
    expect(snapshot.canonicalBytes).toBe(17n);
    expect(snapshot.rawBytes).toBe(utf8ByteLength(raw));
  });
});

describe("hash registry primitives", () => {
  it("computes SHA-256 over a hand-built row-hash preimage", () => {
    // The preimage is assembled here rather than by `rowHash`, so the digest
    // primitive is checked against a plan value with no engine shortcut.
    const encoder = new TextEncoder();
    const domain = encoder.encode("dasher.fx-rate-evidence.v1\0");
    const body = encoder.encode(R7_EVIDENCE_BYTES);
    const preimage = new Uint8Array(domain.length + 4 + body.length);
    preimage.set(domain, 0);
    new DataView(preimage.buffer).setUint32(domain.length, body.length, false);
    preimage.set(body, domain.length + 4);
    expect(sha256Hex(preimage)).toBe(R7_IDENTITIES.evidenceSha256);
  });

  it("hashes a semantic row as domain, NUL, unsigned-32 length, exact bytes", () => {
    const bytes =
      '{"from_currency":"USD","observed_at":"2026-08-04T12:00:00.000000Z","rate":{"coefficient":"925","scale":"i64:3"},"schema":"fx-rate-evidence-v1","to_currency":"EUR"}';
    expect(rowHash("dasher.fx-rate-evidence.v1", bytes)).toBe(
      "4c9d1cb4c1d8f578e39a485bcaf1df9a3c158b98bcad3cd0940cf04d2f44b522",
    );
  });

  it("derives the frozen zero-key group row UUIDv8", () => {
    expect(
      uuidV8("dasher.group-row-id.v1", [
        canonicalBinaryUuid("00000000-0000-8000-8000-000000000303"),
        canonicalBinaryI64(0n),
      ]),
    ).toBe("4c5b6acc-0c61-8c42-a6b6-35d927aed9fb");
  });

  it("derives the frozen result UUIDv8 with unprefixed SHA bytes", () => {
    expect(
      uuidV8("dasher.calculation-result-id.v1", [
        canonicalBinaryUuid("00000000-0000-8000-8000-000000000107"),
        canonicalBinaryShaBytes(
          "2ccca8194640e0190f55f25c09be014b007a6e07b6cdcab907f1b6a5f92acc4f",
        ),
        canonicalBinaryShaBytes(
          "99e0fa493afd7fef604afe1f933ac4d27b38fee35bc3c0fc8ecce258f8d887c8",
        ),
        canonicalBinaryText("calculation-registry-v1"),
        canonicalBinaryText("calculation-limits-v1"),
      ]),
    ).toBe("782f2b22-b86a-8bda-8eae-451cc3f3a26e");
  });

  it("length-prefixes text and raw-encodes SHA bytes distinctly", () => {
    expect([...canonicalBinaryText("ab")]).toEqual([0, 0, 0, 2, 97, 98]);
    expect(canonicalBinaryShaBytes("00".repeat(32)).length).toBe(32);
    expect([...canonicalBinaryI64(-1n)]).toEqual([
      255, 255, 255, 255, 255, 255, 255, 255,
    ]);
  });
});

describe("closed temporal parsing", () => {
  it("accepts UTC RFC 3339 with exactly six fractional digits", () => {
    expect(parseTimestampMicros("2026-08-04T12:00:00.000000Z")).toBe(
      1785844800000000n,
    );
    expect(parseTimestampMicros("2026-08-05T12:00:00.000001Z")).toBe(
      1785931200000001n,
    );
  });

  it("rejects every other instant spelling", () => {
    for (const text of [
      "2026-08-04T12:00:00Z",
      "2026-08-04T12:00:00.000Z",
      "2026-08-04T12:00:00.000000+00:00",
      "2026-08-04t12:00:00.000000Z",
      "2026-08-04T12:00:00.000000",
      "2026-13-04T12:00:00.000000Z",
      "2026-02-30T12:00:00.000000Z",
      "2026-08-04T24:00:00.000000Z",
      "2026-08-04T12:60:00.000000Z",
      "2026-08-04T12:00:61.000000Z",
    ]) {
      expect(parseTimestampMicros(text)).toBeNull();
    }
  });

  it("parses dates as signed days from 1970-01-01", () => {
    expect(parseDateText("1970-01-01")).toBe(0n);
    expect(parseDateText("1969-12-31")).toBe(-1n);
    expect(parseDateText("2024-02-29")).toBe(19782n);
    expect(parseDateText("2023-02-29")).toBeNull();
    expect(parseDateText("2026-8-04")).toBeNull();
  });

  it("round-trips civil days", () => {
    for (const days of [-719162n, -1n, 0n, 19782n, 2932896n]) {
      const civil = civilFromDays(days);
      expect(daysFromCivil(civil.year, civil.month, civil.day)).toBe(days);
    }
  });
});
