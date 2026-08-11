/**
 * `@dasher/calculation-engine` — the pure, side-effect-free deterministic graph
 * runtime for `calculation-registry-v1`.
 *
 * The package has no database, filesystem, network, clock, random, process,
 * dynamic import, eval, `Function` constructor, SQL, or provider dependency, and
 * it neither accepts nor parses `attempt-actual-accounting-v1`.
 */

import {
  CanonicalLimitError,
  jcsEncode,
  parseStrictJson as parseStrictJsonUnguarded,
  snapshotRawGraphBytes as snapshotRawGraphBytesUnguarded,
  snapshotUntrusted as snapshotUntrustedUnguarded,
} from "./canonical";
import {
  CalculationFailure,
  type ErrorCode,
  canonicalizeDocument as canonicalizeDocumentUnguarded,
  parseCalculationGraph as parseCalculationGraphUnguarded,
  parseCanonicalInputTable as parseCanonicalInputTableUnguarded,
  parseCommonEvidenceBundle as parseCommonEvidenceBundleUnguarded,
  parseFieldCatalogSnapshot as parseFieldCatalogSnapshotUnguarded,
  parseFxRateEvidence as parseFxRateEvidenceUnguarded,
  parseMetricContractSet as parseMetricContractSetUnguarded,
} from "./schema";
import {
  type ValidatedGraph,
  validateGraph as validateGraphUnguarded,
} from "./validate";
import {
  type CalculationOutcome,
  evaluateGraph as evaluateGraphUnguarded,
} from "./evaluate";

export {
  CANONICAL_AST_BYTE_CEILING,
  RAW_GRAPH_BYTE_CEILING,
  type CanonicalObject,
  type CanonicalValue,
  compareUtf8,
  jcsEncode,
  rowHash,
  sha256Hex,
  utf8ByteLength,
  uuidV8,
} from "./canonical";

/* ------------------------------------------------------------------ *
 * Closed error boundary
 * ------------------------------------------------------------------ */

/**
 * Maps any exception raised while reading untrusted input to a closed code.
 *
 * A malformed document must never surface a host `SyntaxError`, `TypeError`, or
 * `RangeError`: those carry a stack trace with absolute paths and internal line
 * numbers, and they are outside the seventeen semantic codes a caller can act on.
 * The detail text is a fixed string for the same reason — no host message, path,
 * or offset is copied into it.
 */
function closedFailure(error: unknown): CalculationFailure {
  if (error instanceof CalculationFailure) return error;
  if (error instanceof CanonicalLimitError) {
    return new CalculationFailure(
      "limit_exceeded",
      "input exceeds a canonical byte ceiling",
    );
  }
  return new CalculationFailure(
    "invalid_graph",
    "input is not a well-formed canonical document",
  );
}

/** Wraps one untrusted-input entry point in the closed error boundary. */
function guarded<A extends unknown[], R>(
  operation: (...args: A) => R,
): (...args: A) => R {
  return (...args: A): R => {
    try {
      return operation(...args);
    } catch (error) {
      throw closedFailure(error);
    }
  };
}

/*
 * Every exported function that reads an untrusted document goes through the
 * boundary. The unguarded forms remain internal so intra-package calls keep their
 * existing control flow.
 */
export const parseStrictJson = guarded(parseStrictJsonUnguarded);
export const snapshotRawGraphBytes = guarded(snapshotRawGraphBytesUnguarded);
export const snapshotUntrusted = guarded(snapshotUntrustedUnguarded);
export const canonicalizeDocument = guarded(canonicalizeDocumentUnguarded);
export const parseCalculationGraph = guarded(parseCalculationGraphUnguarded);
export const parseCanonicalInputTable = guarded(
  parseCanonicalInputTableUnguarded,
);
export const parseCommonEvidenceBundle = guarded(
  parseCommonEvidenceBundleUnguarded,
);
export const parseFieldCatalogSnapshot = guarded(
  parseFieldCatalogSnapshotUnguarded,
);
export const parseFxRateEvidence = guarded(parseFxRateEvidenceUnguarded);
export const parseMetricContractSet = guarded(parseMetricContractSetUnguarded);
export const validateGraph = guarded(validateGraphUnguarded);
export const evaluateGraph = guarded(evaluateGraphUnguarded);

export {
  type CanonicalDecimal,
  type Rational,
  type Rounding,
  I64_MAX,
  I64_MIN,
  MAX_COEFFICIENT_DIGITS,
  MAX_SCALE,
  canonicalizeDecimal,
  coefficientDigits,
  formatTaggedI64,
  parseDecimalObject,
  parseTaggedI64,
  quantize,
} from "./decimal";

export {
  CURRENCY_REGISTRY,
  FX_MAX_AGE_MILLIS,
  LIMITS,
  type Limits,
  type Op,
  OP_FIELDS,
  ROWSET_OPS,
  SCALAR_WIDTHS,
  UNIT_REGISTRY,
  UNIT_REGISTRY_VERSION,
  convertCurrencyValue,
  convertUnitValue,
  lookupCurrency,
  lookupUnit,
  primitiveStepCharge,
  stepsL,
} from "./registry";

export {
  type CalculationGraph,
  type CanonicalInputTable,
  type CommonEvidenceBundle,
  type ErrorCode,
  type FieldCatalogSnapshot,
  type FxRateEvidence,
  type GraphNode,
  type MetricContractSet,
  type MetricContractVersion,
  type OutputFieldType,
  type OutputType,
  type RuntimeValue,
  CalculationFailure,
  ERROR_CODES,
  encodeTypedValue,
  outputTypesEqual,
} from "./schema";

export {
  type FreshnessTrio,
  type StaticMeter,
  type ValidatedGraph,
  type ValidateOptions,
  deriveGroupGrain,
  deriveGroupRowId,
  derivedGroupFieldId,
  derivedSelectFieldId,
  requireLimits,
} from "./validate";

export {
  type CalculationOutcome,
  type RuntimeMeter,
  deriveResultId,
  outputValueDigest,
} from "./evaluate";

export interface CalculationRequest {
  /** Untrusted raw graph UTF-8, gated at 131,072 bytes before any parse. */
  readonly rawGraphBytes: string;
  /** Exact canonical bytes returned by the claimed-input read. */
  readonly inputBytes: string;
  readonly catalogBytes: string;
  readonly contractSetBytes?: string;
  readonly bundleBytes?: string;
  readonly fxEvidenceBytes?: string;
  /** Group-grain calendar for AST-only fixtures without a contract set. */
  readonly calendar?: string;
  readonly skipContractConformance?: boolean;
}

export interface CalculationRun {
  readonly validated: ValidatedGraph | null;
  readonly outcome: CalculationOutcome | null;
  readonly error_code: ErrorCode | null;
}

function parseDocument(text: string): {
  value: ReturnType<typeof parseStrictJsonUnguarded>;
  canonicalText: string;
} {
  const value = parseStrictJsonUnguarded(text);
  return { value, canonicalText: jcsEncode(value) };
}

function validateCalculationUnguarded(
  request: CalculationRequest,
): ValidatedGraph {
  const rawGraph = snapshotRawGraphBytesUnguarded(request.rawGraphBytes);
  const graph = parseCalculationGraphUnguarded(
    rawGraph.value,
    rawGraph.canonicalText,
  );
  const inputDocument = parseDocument(request.inputBytes);
  const input = parseCanonicalInputTableUnguarded(
    inputDocument.value,
    inputDocument.canonicalText,
  );
  const catalogDocument = parseDocument(request.catalogBytes);
  const catalog = parseFieldCatalogSnapshotUnguarded(
    catalogDocument.value,
    catalogDocument.canonicalText,
  );
  const contractSet =
    request.contractSetBytes === undefined
      ? undefined
      : (() => {
          const document = parseDocument(request.contractSetBytes as string);
          return parseMetricContractSetUnguarded(
            document.value,
            document.canonicalText,
          );
        })();
  const bundle =
    request.bundleBytes === undefined
      ? undefined
      : (() => {
          const document = parseDocument(request.bundleBytes as string);
          return parseCommonEvidenceBundleUnguarded(
            document.value,
            document.canonicalText,
          );
        })();
  const fxEvidence =
    request.fxEvidenceBytes === undefined
      ? undefined
      : (() => {
          const document = parseDocument(request.fxEvidenceBytes as string);
          return parseFxRateEvidenceUnguarded(
            document.value,
            document.canonicalText,
          );
        })();
  return validateGraphUnguarded({
    graph,
    input,
    catalog,
    ...(contractSet === undefined ? {} : { contractSet }),
    ...(bundle === undefined ? {} : { bundle }),
    ...(fxEvidence === undefined ? {} : { fxEvidence }),
    ...(request.calendar === undefined ? {} : { calendar: request.calendar }),
    ...(request.skipContractConformance === undefined
      ? {}
      : { skipContractConformance: request.skipContractConformance }),
  });
}

/**
 * Validates a request and returns the validated graph, or throws its closed
 * failure. No host exception escapes: a malformed request is one of the
 * seventeen semantic codes.
 */
export const validateCalculation: (
  request: CalculationRequest,
) => ValidatedGraph = guarded(validateCalculationUnguarded);

/**
 * Validates and evaluates one request. A static failure returns a typed error
 * code with no outcome; a runtime failure returns a typed failed envelope.
 *
 * The catch is total. Every exception — including one raised by a host primitive
 * on a pathological document — is mapped to a closed code, so a caller never
 * receives a stack trace and never has to distinguish engine errors from input
 * errors.
 */
export function runCalculation(request: CalculationRequest): CalculationRun {
  try {
    const validated = validateCalculationUnguarded(request);
    return {
      validated,
      outcome: evaluateGraphUnguarded(validated),
      error_code: null,
    };
  } catch (error) {
    return {
      validated: null,
      outcome: null,
      error_code: closedFailure(error).code,
    };
  }
}
