import { describe, expect, it } from "vitest";

import { canonicalSpecBytes } from "./canonical";
import type { DashboardSpec } from "./schema";

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/**
 * The property that matters is not the exact bytes, which are an implementation
 * detail, but that two specs equal in value produce one hash.
 */
describe("canonicalSpecBytes", () => {
  const base = {
    schemaVersion: "1.2",
    title: "Quarterly spend",
    pages: [{ id: "a", title: "A", components: [] }],
  } as unknown as DashboardSpec;

  it("is stable across key insertion order", () => {
    // The realistic source of divergence: one spec built literally, another
    // spread from a parsed object, equal in every value.
    const reordered = {
      pages: [{ components: [], title: "A", id: "a" }],
      title: "Quarterly spend",
      schemaVersion: "1.2",
    } as unknown as DashboardSpec;

    expect(
      sameBytes(canonicalSpecBytes(base), canonicalSpecBytes(reordered)),
    ).toBe(true);
  });

  it("preserves array order, which is meaning rather than layout", () => {
    const swapped = {
      ...base,
      pages: [
        { id: "b", title: "B", components: [] },
        { id: "a", title: "A", components: [] },
      ],
    } as unknown as DashboardSpec;
    const original = {
      ...base,
      pages: [
        { id: "a", title: "A", components: [] },
        { id: "b", title: "B", components: [] },
      ],
    } as unknown as DashboardSpec;

    expect(
      sameBytes(canonicalSpecBytes(swapped), canonicalSpecBytes(original)),
    ).toBe(false);
  });

  it("round-trips through JSON to an equal value", () => {
    const parsed = JSON.parse(
      new TextDecoder().decode(canonicalSpecBytes(base)),
    ) as unknown;
    expect(parsed).toStrictEqual(JSON.parse(JSON.stringify(base)));
  });

  it("drops undefined rather than pretending it serialises", () => {
    const withUndefined = {
      ...base,
      subtitle: undefined,
    } as unknown as DashboardSpec;
    expect(
      sameBytes(canonicalSpecBytes(withUndefined), canonicalSpecBytes(base)),
    ).toBe(true);
  });
});
