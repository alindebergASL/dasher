import type { DashboardSpec } from "./schema";

/**
 * The one byte representation of a dashboard spec.
 *
 * WHY THIS EXISTS AT ALL. `dasher_api.finalize_run` stores the bytes and their
 * SHA-256 together, and `dashboard_versions.canonical_spec_sha256` is what a
 * later reader compares against to know the row was not edited underneath it.
 * That comparison is worth nothing if the same spec can serialise two ways, so
 * "canonical" has to be a property of this function rather than a hope about
 * how the object was built.
 *
 * WHY KEY ORDER IS FORCED. `JSON.stringify` emits keys in insertion order, so
 * two specs equal in every value would hash differently if one was assembled
 * field by field and the other spread from a parsed object. That is not a
 * hypothetical: `compilePlan` builds some objects literally and others by
 * spreading, and a refinement round-trips a plan through the browser. Sorting
 * removes the question.
 *
 * Arrays are left alone. Their order is meaning — pages, sections, and trend
 * points are sequences the reader sees — and sorting them would change the
 * dashboard rather than normalise it.
 *
 * Returns `Uint8Array` rather than `Buffer` because this package carries no
 * Node types on purpose: the spec contract is shared with the browser, and
 * reaching for `Buffer` here would drag `@types/node` into a package that has
 * deliberately avoided it. `pg` accepts a `Uint8Array` for a `bytea` parameter,
 * so nothing downstream needs the richer type.
 */
export function canonicalSpecBytes(spec: DashboardSpec): Uint8Array {
  return canonicalBytes(spec);
}

/**
 * The same canonicalisation, for a fragment rather than a whole spec.
 *
 * A claim's `assertion_sha256` is the digest of the sub-document its JSON
 * pointer addresses, so the fragment has to serialise by exactly the rule the
 * whole spec serialises by. Sharing the function is the only way that stays
 * true: two sorters would be two answers to "what are these bytes", and the
 * one place it matters is the comparison that is supposed to detect an edit.
 */
export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(sortKeys(value)));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;

  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    // `undefined` is dropped by JSON.stringify anyway; skipping it here keeps
    // the sorted object honest about what will actually be serialised.
    if (source[key] !== undefined) sorted[key] = sortKeys(source[key]);
  }
  return sorted;
}
