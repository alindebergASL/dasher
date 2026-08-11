/**
 * `calculation-limits-v1`: the single frozen ceilings object.
 *
 * Section 5.3 requires one versioned limits object shared by static admission and
 * runtime metering, so every ceiling in this package — including the canonical
 * byte gates and the decimal coefficient/scale bounds — is read from here rather
 * than restated. This module deliberately imports nothing, so the canonical
 * encoder, the decimal primitives, and the registry can all depend on it without a
 * cycle.
 */

/** `calculation-limits-v1`: one object shared by static admission and runtime. */
export const LIMITS = Object.freeze({
  canonicalInputBytes: 1048576n,
  rawGraphBytes: 131072n,
  astBytes: 65536n,
  nodeCount: 128n,
  maxDepth: 32n,
  literalBytes: 4096n,
  totalLiteralBytes: 32768n,
  literalListLength: 256n,
  topK: 1000n,
  windowFrame: 10000n,
  coefficientDigits: 38n,
  scale: 18n,
  scannedRows: 10000n,
  groups: 1000n,
  rowsInGroup: 10000n,
  cumulativeIntermediateRows: 50000n,
  finalOutputRows: 2000n,
  cumulativeIntermediateBytes: 8388608n,
  outputBytes: 1048576n,
  primitiveSteps: 1000000n,
  logicalAllocationBytes: 33554432n,
});

export type Limits = typeof LIMITS;

/**
 * The widest canonical byte span any single runtime value may occupy: a value is
 * always accounted in either the intermediate or the output byte meter, so a
 * declared width above the larger of those ceilings is inadmissible in every
 * position. Declared widths are compared against this bound in `bigint` before any
 * `Number()` conversion or allocation derives from them.
 */
export const MAX_DECLARED_VALUE_BYTES: bigint =
  LIMITS.cumulativeIntermediateBytes > LIMITS.outputBytes
    ? LIMITS.cumulativeIntermediateBytes
    : LIMITS.outputBytes;
