/**
 * Static validation of a `calculation-graph-v1` graph.
 *
 * The validator rederives every output type, field ID, grain, range bound, and
 * static meter from the canonical AST, catalog, and input snapshot, and only then
 * compares the caller-supplied bytes. Failure selection follows the exact plan
 * order: `invalid_graph`, `invalid_timezone`, `missing_field`, `cycle`,
 * `type_mismatch`, `grain_mismatch`, `currency_mismatch`, `unit_mismatch`, and
 * finally every static meter ceiling as `limit_exceeded`.
 */

import {
  canonicalBinaryI64,
  canonicalBinaryText,
  canonicalBinaryUuid,
  compareUtf8,
  jcsEncode,
  sha256Hex,
  uuidV8,
  utf8ByteLength,
} from "./canonical";
import {
  type CanonicalDecimal,
  I64_MAX,
  checkedAdd,
  checkedMultiply,
  coefficientDigits,
} from "./decimal";
import {
  CLASSIFY_STATE_WIDTH,
  FX_MAX_AGE_MILLIS,
  GROUPED_AGGREGATE_OPS,
  LIMITS,
  MAX_DECLARED_VALUE_BYTES,
  type Op,
  ROWSET_OPS,
  SCALAR_WIDTHS,
  type ScalarType,
  type StepCounts,
  lookupCurrency,
  lookupUnit,
  primitiveStepCharge,
} from "./registry";
import {
  type CalculationGraph,
  type CanonicalInputTable,
  type CatalogField,
  type CommonEvidenceBundle,
  type FieldCatalogSnapshot,
  type FxRateEvidence,
  type GraphNode,
  type MetricContractSet,
  type MetricContractVersion,
  type OutputFieldType,
  type OutputType,
  type RuntimeValue,
  encodeOutputType,
  encodeTypedValue,
  fail,
  outputTypesEqual,
  parseContractDecimalText,
  referencedNodeIds,
  textTokenWidth,
} from "./schema";

const DERIVED_FIELD_DOMAIN = "dasher.derived-field.v1";
const GROUP_ROW_DOMAIN = "dasher.group-row-id.v1";
const GROUP_GRAIN_DOMAIN = "dasher.metric-group-grain.v1";

export interface StaticMeter {
  readonly input_bytes: bigint;
  readonly ast_bytes: bigint;
  readonly node_count: bigint;
  readonly max_depth: bigint;
  readonly max_literal_bytes: bigint;
  readonly total_literal_bytes: bigint;
  readonly max_literal_list_length: bigint;
  readonly scanned_rows: bigint;
  readonly group_count: bigint;
  readonly max_group_rows: bigint;
  readonly cumulative_intermediate_rows: bigint;
  readonly final_output_rows: bigint;
  readonly cumulative_intermediate_bytes: bigint;
  readonly output_bytes: bigint;
  readonly primitive_steps: bigint;
  readonly logical_allocation_bytes: bigint;
  readonly max_top_k: bigint;
  readonly max_window_frame: bigint;
  readonly max_coefficient_digits: bigint;
  readonly max_scale: bigint;
}

export interface FreshnessTrio {
  readonly classifier_node_id: string;
  readonly input_node_id: string;
}

export interface ValidatedGraph {
  readonly graph: CalculationGraph;
  readonly input: CanonicalInputTable;
  readonly catalog: FieldCatalogSnapshot;
  readonly contract: MetricContractVersion | null;
  readonly nodesById: ReadonlyMap<string, GraphNode>;
  readonly order: readonly GraphNode[];
  readonly derivedTypes: ReadonlyMap<string, OutputType>;
  readonly groupGrains: ReadonlyMap<string, string>;
  readonly sortCertificates: ReadonlyMap<string, bigint>;
  readonly depths: ReadonlyMap<string, bigint>;
  readonly upperRows: ReadonlyMap<string, bigint>;
  readonly staticMeter: StaticMeter;
  readonly fxEvidence: FxRateEvidence | null;
  readonly freshness: FreshnessTrio | null;
}

export interface ValidateOptions {
  readonly graph: CalculationGraph;
  readonly input: CanonicalInputTable;
  readonly catalog: FieldCatalogSnapshot;
  /** The bound contract set; required for contract conformance. */
  readonly contractSet?: MetricContractSet;
  readonly bundle?: CommonEvidenceBundle;
  readonly fxEvidence?: FxRateEvidence;
  /**
   * Calendar used for group-grain derivation when no contract set is supplied.
   * With a contract set the bound contract's calendar is authoritative.
   */
  readonly calendar?: string;
  /** Skips the MetricContractVersion conformance layer for AST-only fixtures. */
  readonly skipContractConformance?: boolean;
}

/* ------------------------------------------------------------------ *
 * Derived identities
 * ------------------------------------------------------------------ */

/** `select` derived field ID: domain, select node, tagged ordinal, name, value node. */
export function derivedSelectFieldId(
  selectNodeId: string,
  ordinal: bigint,
  name: string,
  valueNodeId: string,
): string {
  return uuidV8(DERIVED_FIELD_DOMAIN, [
    canonicalBinaryUuid(selectNodeId),
    canonicalBinaryI64(ordinal),
    canonicalBinaryText(name),
    canonicalBinaryUuid(valueNodeId),
  ]);
}

/** `group` derived field ID: domain, group node, text `key`, tagged ordinal, key node. */
export function derivedGroupFieldId(
  groupNodeId: string,
  ordinal: bigint,
  keyNodeId: string,
): string {
  return uuidV8(DERIVED_FIELD_DOMAIN, [
    canonicalBinaryUuid(groupNodeId),
    canonicalBinaryText("key"),
    canonicalBinaryI64(ordinal),
    canonicalBinaryUuid(keyNodeId),
  ]);
}

/**
 * `group:` plus the hash-registry digest over calendar, timezone, dimension
 * count, and each field UUID in sorted order. Zero dimensions hash the exact
 * zero-count prefix.
 */
export function deriveGroupGrain(
  calendar: string,
  timezone: string,
  fieldIds: readonly string[],
): string {
  const sorted = [...fieldIds].sort(compareUtf8);
  const parts = [
    canonicalBinaryText(calendar),
    canonicalBinaryText(timezone),
    canonicalBinaryI64(BigInt(sorted.length)),
    ...sorted.map((id) => canonicalBinaryUuid(id)),
  ];
  const encoder = new TextEncoder();
  const domain = encoder.encode(`${GROUP_GRAIN_DOMAIN}\0`);
  let total = domain.length;
  for (const part of parts) total += part.length;
  const preimage = new Uint8Array(total);
  preimage.set(domain, 0);
  let offset = domain.length;
  for (const part of parts) {
    preimage.set(part, offset);
    offset += part.length;
  }
  return `group:${sha256Hex(preimage)}`;
}

/** A group row ID over the group node, key count, and each admitted key value. */
export function deriveGroupRowId(
  groupNodeId: string,
  keys: readonly RuntimeValue[],
  encodeKey: (value: RuntimeValue) => Uint8Array,
): string {
  return uuidV8(GROUP_ROW_DOMAIN, [
    canonicalBinaryUuid(groupNodeId),
    canonicalBinaryI64(BigInt(keys.length)),
    ...keys.map(encodeKey),
  ]);
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function scalarWidth(type: ScalarType, declared?: bigint): bigint {
  if (type === "text") {
    if (declared === undefined) {
      fail("type_mismatch", "text scalars require an explicit width");
    }
    return declared;
  }
  return SCALAR_WIDTHS[type];
}

function isNumeric(type: ScalarType | null): boolean {
  return type === "integer" || type === "decimal";
}

function requireScalar(type: OutputType, path: string): OutputType {
  if (type.shape !== "scalar")
    fail("type_mismatch", `${path} must be a scalar`);
  return type;
}

function requireRowset(type: OutputType, path: string): OutputType {
  if (type.shape !== "rowset")
    fail("type_mismatch", `${path} must be a rowset`);
  return type;
}

function scalarType(
  scalar: ScalarType,
  nullable: boolean,
  unit: string | null,
  currency: string | null,
  grain: string | null,
  width: bigint,
): OutputType {
  return {
    shape: "scalar",
    scalar,
    nullable,
    unit,
    currency,
    grain,
    max_value_bytes: width,
    fields: null,
  };
}

function rowsetType(fields: readonly OutputFieldType[]): OutputType {
  return {
    shape: "rowset",
    scalar: null,
    nullable: null,
    unit: null,
    currency: null,
    grain: null,
    max_value_bytes: null,
    fields,
  };
}

function checkedSum(values: readonly bigint[]): bigint {
  let total = 0n;
  for (const value of values) {
    const next = checkedAdd(total, value);
    if (next === null)
      fail("limit_exceeded", "checked signed-64 addition overflowed");
    total = next;
  }
  return total;
}

function checkedProduct(left: bigint, right: bigint): bigint {
  const product = checkedMultiply(left, right);
  if (product === null) {
    fail("limit_exceeded", "checked signed-64 multiplication overflowed");
  }
  return product;
}

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

export function validateGraph(options: ValidateOptions): ValidatedGraph {
  const { graph, input, catalog } = options;

  if (graph.input_snapshot_id !== input.input_snapshot_id) {
    fail("invalid_graph", "graph input snapshot differs from the parsed input");
  }
  if (graph.input_sha256 !== input.input_sha256) {
    fail("invalid_graph", "graph input SHA differs from the parsed input");
  }
  if (graph.field_catalog_snapshot_id !== catalog.catalog_snapshot_id) {
    fail(
      "invalid_graph",
      "graph catalog snapshot differs from the parsed catalog",
    );
  }
  if (graph.field_catalog_sha256 !== catalog.catalog_sha256) {
    fail("invalid_graph", "graph catalog SHA differs from the parsed catalog");
  }
  if (catalog.input_snapshot_id !== input.input_snapshot_id) {
    fail("invalid_graph", "catalog names another input snapshot");
  }
  if (catalog.input_sha256 !== input.input_sha256) {
    fail("invalid_graph", "catalog names another input SHA");
  }
  if (catalog.input_row_count !== input.row_count) {
    fail("invalid_graph", "catalog row count differs from the input row count");
  }

  const contract = options.skipContractConformance
    ? null
    : resolveContract(options);
  const calendar = contract?.calendar ?? options.calendar ?? "gregorian";
  if (contract !== null && contract.timezone !== graph.timezone) {
    fail("invalid_timezone", "contract timezone differs from graph timezone");
  }

  const nodesById = new Map<string, GraphNode>();
  for (const node of graph.nodes) nodesById.set(node.node_id, node);

  // missing_field precedes cycle detection.
  for (const node of graph.nodes) {
    for (const reference of referencedNodeIds(node)) {
      if (!nodesById.has(reference)) {
        fail(
          "missing_field",
          `node ${node.node_id} references unknown ${reference}`,
        );
      }
    }
  }
  for (const id of graph.output_node_ids) {
    if (!nodesById.has(id))
      fail("missing_field", `output node ${id} is not defined`);
  }
  if (!nodesById.has(graph.contract_output_node_id)) {
    fail("missing_field", "contract_output_node_id is not defined");
  }

  const order = requireCanonicalTopologicalOrder(graph, nodesById);
  const depths = computeDepths(order);

  const catalogById = new Map<string, CatalogField>();
  for (const field of catalog.fields) catalogById.set(field.field_id, field);

  const state: DerivationState = {
    graph,
    catalog,
    catalogById,
    nodesById,
    calendar,
    derived: new Map(),
    groupGrains: new Map(),
    sortCertificates: new Map(),
    deriving: new Set(),
    contextualLiterals: contextualLiteralNodes(graph, nodesById),
  };

  for (const node of order) deriveNodeType(state, node);

  const upperRows = computeUpperRows(state, order, catalog);
  const staticMeter = computeStaticMeter(state, order, input, upperRows);
  requireLimits(staticMeter);

  const fxEvidence = validateFxBinding(options, state);
  const freshness = deriveFreshnessTrio(state, order);

  if (contract !== null) {
    validateContractConformance(options, state, contract, order, freshness);
  }

  return {
    graph,
    input,
    catalog,
    contract,
    nodesById,
    order,
    derivedTypes: state.derived,
    groupGrains: state.groupGrains,
    sortCertificates: state.sortCertificates,
    depths,
    upperRows,
    staticMeter,
    fxEvidence,
    freshness,
  };
}

function resolveContract(
  options: ValidateOptions,
): MetricContractVersion | null {
  const { contractSet, graph } = options;
  if (contractSet === undefined) return null;
  if (contractSet.contract_set_id !== graph.contract_set_id) {
    fail("invalid_graph", "contract set ID differs from the graph binding");
  }
  if (contractSet.catalog_snapshot_id !== graph.field_catalog_snapshot_id) {
    fail("invalid_graph", "contract set names another catalog snapshot");
  }
  const contract = contractSet.contracts.find(
    (entry) =>
      entry.contract_id === graph.contract_id &&
      entry.version === graph.contract_version,
  );
  if (contract === undefined) {
    fail(
      "missing_field",
      "the bound MetricContractVersion is absent from the set",
    );
  }
  return contract;
}

/* ------------------------------------------------------------------ *
 * Canonical topological order
 * ------------------------------------------------------------------ */

function requireCanonicalTopologicalOrder(
  graph: CalculationGraph,
  nodesById: ReadonlyMap<string, GraphNode>,
): readonly GraphNode[] {
  const pending = new Map<string, Set<string>>();
  for (const node of graph.nodes) {
    pending.set(node.node_id, new Set(referencedNodeIds(node)));
  }
  const emitted = new Set<string>();
  const order: GraphNode[] = [];
  while (order.length < graph.nodes.length) {
    const ready = [...pending.entries()]
      .filter(
        ([id, refs]) =>
          !emitted.has(id) && [...refs].every((r) => emitted.has(r)),
      )
      .map(([id]) => id)
      .sort(compareUtf8);
    const next = ready[0];
    if (next === undefined) fail("cycle", "graph nodes do not form a DAG");
    emitted.add(next);
    order.push(nodesById.get(next) as GraphNode);
  }
  for (let index = 0; index < order.length; index += 1) {
    if (
      (order[index] as GraphNode).node_id !==
      (graph.nodes[index] as GraphNode).node_id
    ) {
      fail("invalid_graph", "nodes are not in deterministic topological order");
    }
  }
  return order;
}

function computeDepths(
  order: readonly GraphNode[],
): ReadonlyMap<string, bigint> {
  const depths = new Map<string, bigint>();
  for (const node of order) {
    let depth = 1n;
    for (const reference of referencedNodeIds(node)) {
      const referenced = depths.get(reference);
      if (referenced === undefined) {
        fail("cycle", `node ${node.node_id} references a later node`);
      }
      const candidate = referenced + 1n;
      if (candidate > depth) depth = candidate;
    }
    depths.set(node.node_id, depth);
  }
  return depths;
}

/* ------------------------------------------------------------------ *
 * Type derivation
 * ------------------------------------------------------------------ */

interface DerivationState {
  readonly graph: CalculationGraph;
  readonly catalog: FieldCatalogSnapshot;
  readonly catalogById: ReadonlyMap<string, CatalogField>;
  readonly nodesById: ReadonlyMap<string, GraphNode>;
  readonly calendar: string;
  readonly derived: Map<string, OutputType>;
  readonly groupGrains: Map<string, string>;
  readonly sortCertificates: Map<string, bigint>;
  readonly deriving: Set<string>;
  /** Threshold and target literal nodes, mapped to their comparison node. */
  readonly contextualLiterals: ReadonlyMap<string, string>;
}

function contextualLiteralNodes(
  graph: CalculationGraph,
  nodesById: ReadonlyMap<string, GraphNode>,
): ReadonlyMap<string, string> {
  const literals = new Map<string, string>();
  for (const comparisonId of [graph.threshold_node_id, graph.target_node_id]) {
    if (comparisonId === null) continue;
    const comparison = nodesById.get(comparisonId);
    if (comparison === undefined) {
      fail("missing_field", "threshold or target node is not defined");
    }
    const right = comparison.right;
    if (right === undefined) {
      fail("invalid_graph", "threshold or target node is not a comparison");
    }
    literals.set(right, comparisonId);
  }
  return literals;
}

function typeOf(state: DerivationState, nodeId: string): OutputType {
  const existing = state.derived.get(nodeId);
  if (existing !== undefined) return existing;
  const node = state.nodesById.get(nodeId);
  if (node === undefined)
    fail("missing_field", `node ${nodeId} is not defined`);
  return deriveNodeType(state, node);
}

function domainOf(state: DerivationState, nodeId: string): string | null {
  const node = state.nodesById.get(nodeId);
  if (node === undefined)
    fail("missing_field", `node ${nodeId} is not defined`);
  return node.evaluation_rows_from;
}

function requireSameDomain(
  state: DerivationState,
  node: GraphNode,
  references: readonly string[],
): void {
  for (const reference of references) {
    if (domainOf(state, reference) !== node.evaluation_rows_from) {
      fail(
        "type_mismatch",
        `node ${node.node_id} operand evaluation domain drifts`,
      );
    }
  }
}

function deriveNodeType(state: DerivationState, node: GraphNode): OutputType {
  const cached = state.derived.get(node.node_id);
  if (cached !== undefined) return cached;
  if (state.deriving.has(node.node_id)) {
    fail("cycle", `node ${node.node_id} participates in a cycle`);
  }
  state.deriving.add(node.node_id);
  const derived = deriveType(state, node);
  state.deriving.delete(node.node_id);

  const declared = node.output_type;
  compareDerivedType(node, derived, declared);
  state.derived.set(node.node_id, derived);
  return derived;
}

/** Compares derived and caller metadata in the exact failure order. */
function compareDerivedType(
  node: GraphNode,
  derived: OutputType,
  declared: OutputType,
): void {
  if (derived.shape !== declared.shape) {
    fail("type_mismatch", `node ${node.node_id} output shape drifts`);
  }
  if (derived.shape === "rowset") {
    const derivedFields = derived.fields ?? [];
    const declaredFields = declared.fields ?? [];
    if (derivedFields.length !== declaredFields.length) {
      fail("type_mismatch", `node ${node.node_id} rowset field count drifts`);
    }
    for (let index = 0; index < derivedFields.length; index += 1) {
      const left = derivedFields[index] as OutputFieldType;
      const right = declaredFields[index] as OutputFieldType;
      if (
        left.field_id !== right.field_id ||
        left.name !== right.name ||
        left.scalar !== right.scalar ||
        left.nullable !== right.nullable ||
        left.max_value_bytes !== right.max_value_bytes
      ) {
        fail("type_mismatch", `node ${node.node_id} field ${index} drifts`);
      }
      if (left.grain !== right.grain) {
        fail(
          "grain_mismatch",
          `node ${node.node_id} field ${index} grain drifts`,
        );
      }
      if (left.currency !== right.currency) {
        fail(
          "currency_mismatch",
          `node ${node.node_id} field ${index} currency drifts`,
        );
      }
      if (left.unit !== right.unit) {
        fail(
          "unit_mismatch",
          `node ${node.node_id} field ${index} unit drifts`,
        );
      }
    }
    return;
  }
  if (
    derived.scalar !== declared.scalar ||
    derived.nullable !== declared.nullable ||
    derived.max_value_bytes !== declared.max_value_bytes
  ) {
    fail("type_mismatch", `node ${node.node_id} scalar output type drifts`);
  }
  if (derived.grain !== declared.grain) {
    fail("grain_mismatch", `node ${node.node_id} grain drifts`);
  }
  if (derived.currency !== declared.currency) {
    fail("currency_mismatch", `node ${node.node_id} currency drifts`);
  }
  if (derived.unit !== declared.unit) {
    fail("unit_mismatch", `node ${node.node_id} unit drifts`);
  }
  if (!outputTypesEqual(derived, declared)) {
    fail("type_mismatch", `node ${node.node_id} output type drifts`);
  }
}

function fieldOfRowset(
  type: OutputType,
  fieldId: string,
  nodeId: string,
): OutputFieldType {
  const field = (type.fields ?? []).find((entry) => entry.field_id === fieldId);
  if (field === undefined) {
    fail("missing_field", `node ${nodeId} names an absent rowset field`);
  }
  return field;
}

function groupGrainOf(state: DerivationState, groupNodeId: string): string {
  const grain = state.groupGrains.get(groupNodeId);
  if (grain === undefined) {
    typeOf(state, groupNodeId);
    const derivedGrain = state.groupGrains.get(groupNodeId);
    if (derivedGrain === undefined) {
      fail("type_mismatch", `node ${groupNodeId} is not a group node`);
    }
    return derivedGrain;
  }
  return grain;
}

function requireDirectFieldNodes(
  state: DerivationState,
  node: GraphNode,
  keyNodeIds: readonly string[],
  inputNodeId: string,
): void {
  for (const keyId of keyNodeIds) {
    const key = state.nodesById.get(keyId);
    if (key === undefined)
      fail("missing_field", `node ${keyId} is not defined`);
    if (key.op !== "field" || key.input !== inputNodeId) {
      fail(
        "type_mismatch",
        `node ${node.node_id} keys must be direct field nodes`,
      );
    }
  }
}

function requireTotalSortKeys(
  state: DerivationState,
  node: GraphNode,
  domainNodeId: string,
): void {
  for (const key of node.keys ?? []) {
    const keyType = requireScalar(
      typeOf(state, key.value_node_id),
      `node ${key.value_node_id}`,
    );
    void keyType;
    if (domainOf(state, key.value_node_id) !== domainNodeId) {
      fail(
        "type_mismatch",
        `node ${node.node_id} sort keys must share the input domain`,
      );
    }
  }
}

function deriveType(state: DerivationState, node: GraphNode): OutputType {
  switch (node.op) {
    case "source": {
      const fields = (node.field_ids ?? []).map((fieldId) => {
        const entry = state.catalogById.get(fieldId);
        if (entry === undefined) {
          fail("missing_field", `source names catalog field ${fieldId}`);
        }
        return {
          field_id: entry.field_id,
          name: entry.logical_name,
          scalar: entry.scalar_type,
          nullable: entry.nullable,
          unit: entry.unit,
          currency: entry.currency,
          grain: entry.grain,
          max_value_bytes: entry.max_value_bytes,
        } satisfies OutputFieldType;
      });
      return rowsetType(fields);
    }
    case "field": {
      const inputType = requireRowset(
        typeOf(state, node.input as string),
        `node ${node.input}`,
      );
      if (node.evaluation_rows_from !== node.input) {
        fail(
          "type_mismatch",
          `node ${node.node_id} domain must equal its input rowset`,
        );
      }
      const field = fieldOfRowset(
        inputType,
        node.field_id as string,
        node.node_id,
      );
      return scalarType(
        field.scalar,
        field.nullable,
        field.unit,
        field.currency,
        field.grain,
        field.max_value_bytes,
      );
    }
    case "literal": {
      const literal = node.literal as RuntimeValue;
      const comparisonId = state.contextualLiterals.get(node.node_id);
      if (comparisonId !== undefined) {
        const contractType = requireScalar(
          typeOf(state, state.graph.contract_output_node_id),
          "contract output",
        );
        if (literal.state !== "present") {
          fail(
            "invalid_graph",
            "a contextual threshold literal must be present",
          );
        }
        if (literal.type !== contractType.scalar) {
          fail(
            "type_mismatch",
            "threshold literal scalar differs from the contract output",
          );
        }
        return scalarType(
          literal.type,
          false,
          contractType.unit,
          contractType.currency,
          contractType.grain,
          contractType.max_value_bytes as bigint,
        );
      }
      const width =
        literal.type === "text"
          ? textTokenWidth(literal.value as string)
          : scalarWidth(literal.type);
      return scalarType(
        literal.type,
        literal.state === "null",
        null,
        null,
        null,
        width < 1n ? 1n : width,
      );
    }
    case "select": {
      const inputId = node.input as string;
      requireRowset(typeOf(state, inputId), `node ${inputId}`);
      const projections = node.projections ?? [];
      const fields = projections.map((projection, index) => {
        const valueType = requireScalar(
          typeOf(state, projection.value_node_id),
          `node ${projection.value_node_id}`,
        );
        if (domainOf(state, projection.value_node_id) !== inputId) {
          fail(
            "type_mismatch",
            "select projections must share the input domain",
          );
        }
        const derivedId = derivedSelectFieldId(
          node.node_id,
          BigInt(index),
          projection.name,
          projection.value_node_id,
        );
        if (derivedId !== projection.field_id) {
          fail("type_mismatch", "select field ID is not the derived UUIDv8");
        }
        return {
          field_id: derivedId,
          name: projection.name,
          scalar: valueType.scalar as ScalarType,
          nullable: valueType.nullable as boolean,
          unit: valueType.unit,
          currency: valueType.currency,
          grain: valueType.grain,
          max_value_bytes: valueType.max_value_bytes as bigint,
        } satisfies OutputFieldType;
      });
      const sorted = [...fields].sort((left, right) =>
        compareUtf8(left.field_id, right.field_id),
      );
      return rowsetType(sorted);
    }
    case "filter": {
      const inputId = node.input as string;
      const inputType = requireRowset(
        typeOf(state, inputId),
        `node ${inputId}`,
      );
      const predicate = requireScalar(
        typeOf(state, node.predicate as string),
        `node ${node.predicate}`,
      );
      if (predicate.scalar !== "boolean") {
        fail("type_mismatch", "filter predicate must be a boolean scalar");
      }
      if (domainOf(state, node.predicate as string) !== inputId) {
        fail("type_mismatch", "filter predicate must share the input domain");
      }
      const certificate = state.sortCertificates.get(inputId);
      if (certificate !== undefined)
        state.sortCertificates.set(node.node_id, certificate);
      return rowsetType(inputType.fields ?? []);
    }
    case "sort": {
      const inputId = node.input as string;
      const inputType = requireRowset(
        typeOf(state, inputId),
        `node ${inputId}`,
      );
      requireTotalSortKeys(state, node, inputId);
      state.sortCertificates.set(
        node.node_id,
        BigInt((node.keys ?? []).length),
      );
      return rowsetType(inputType.fields ?? []);
    }
    case "top_k": {
      const inputId = node.input as string;
      const inputType = requireRowset(
        typeOf(state, inputId),
        `node ${inputId}`,
      );
      const certificate = state.sortCertificates.get(inputId);
      if (certificate === undefined) {
        fail("type_mismatch", "top_k requires an already totally sorted input");
      }
      state.sortCertificates.set(node.node_id, certificate);
      return rowsetType(inputType.fields ?? []);
    }
    case "group": {
      const inputId = node.input as string;
      requireRowset(typeOf(state, inputId), `node ${inputId}`);
      const keyNodeIds = node.key_node_ids ?? [];
      requireDirectFieldNodes(state, node, keyNodeIds, inputId);
      const keyFieldIds = keyNodeIds.map(
        (keyId) => (state.nodesById.get(keyId) as GraphNode).field_id as string,
      );
      if (new Set(keyFieldIds).size !== keyFieldIds.length) {
        fail("invalid_graph", "group keys must be unique");
      }
      state.groupGrains.set(
        node.node_id,
        deriveGroupGrain(state.calendar, state.graph.timezone, keyFieldIds),
      );
      const fields = keyNodeIds.map((keyId, index) => {
        const keyType = requireScalar(typeOf(state, keyId), `node ${keyId}`);
        return {
          field_id: derivedGroupFieldId(node.node_id, BigInt(index), keyId),
          name: `key_${index}`,
          scalar: keyType.scalar as ScalarType,
          nullable: keyType.nullable as boolean,
          unit: keyType.unit,
          currency: keyType.currency,
          grain: keyType.grain,
          max_value_bytes: keyType.max_value_bytes as bigint,
        } satisfies OutputFieldType;
      });
      const sorted = [...fields].sort((left, right) =>
        compareUtf8(left.field_id, right.field_id),
      );
      return rowsetType(sorted);
    }
    case "rank": {
      const inputId = node.input as string;
      requireRowset(typeOf(state, inputId), `node ${inputId}`);
      if (node.evaluation_rows_from !== inputId) {
        fail("type_mismatch", "rank must be evaluated over its input rowset");
      }
      const partitions = node.partition_node_ids ?? [];
      requireDirectFieldNodes(state, node, partitions, inputId);
      requireTotalSortKeys(state, node, inputId);
      const partitionFieldIds = partitions.map(
        (id) => (state.nodesById.get(id) as GraphNode).field_id as string,
      );
      return scalarType(
        "integer",
        false,
        null,
        null,
        deriveGroupGrain(
          state.calendar,
          state.graph.timezone,
          partitionFieldIds,
        ),
        SCALAR_WIDTHS.integer,
      );
    }
    case "count_rows": {
      const groupId = node.group_node_id as string;
      requireRowset(typeOf(state, groupId), `node ${groupId}`);
      if (node.evaluation_rows_from !== groupId) {
        fail("type_mismatch", "count_rows must be evaluated over its group");
      }
      return scalarType(
        "integer",
        false,
        null,
        null,
        groupGrainOf(state, groupId),
        SCALAR_WIDTHS.integer,
      );
    }
    case "count_present":
    case "sum":
    case "min":
    case "max":
    case "mean": {
      const groupId = node.group_node_id as string;
      const groupNode = state.nodesById.get(groupId);
      if (groupNode === undefined || groupNode.op !== "group") {
        fail("type_mismatch", `node ${node.node_id} must name a group node`);
      }
      requireRowset(typeOf(state, groupId), `node ${groupId}`);
      const inputType = requireScalar(
        typeOf(state, node.input as string),
        `node ${node.input}`,
      );
      if (domainOf(state, node.input as string) !== groupNode.input) {
        fail(
          "type_mismatch",
          "aggregate input must be evaluated over the group input",
        );
      }
      if (node.evaluation_rows_from !== groupId) {
        fail(
          "type_mismatch",
          "aggregate output must be evaluated over the group",
        );
      }
      const grain = groupGrainOf(state, groupId);
      if (node.op === "count_present") {
        return scalarType(
          "integer",
          false,
          null,
          null,
          grain,
          SCALAR_WIDTHS.integer,
        );
      }
      if (node.op === "min" || node.op === "max") {
        const allowed: readonly ScalarType[] = [
          "integer",
          "decimal",
          "date",
          "timestamp",
          "duration",
        ];
        if (!allowed.includes(inputType.scalar as ScalarType)) {
          fail("type_mismatch", `${node.op} does not accept this scalar`);
        }
        return scalarType(
          inputType.scalar as ScalarType,
          false,
          inputType.unit,
          inputType.currency,
          grain,
          inputType.max_value_bytes as bigint,
        );
      }
      if (!isNumeric(inputType.scalar)) {
        fail("type_mismatch", `${node.op} requires a numeric input`);
      }
      return scalarType(
        "decimal",
        false,
        inputType.unit,
        inputType.currency,
        grain,
        SCALAR_WIDTHS.decimal,
      );
    }
    case "add":
    case "subtract":
    case "multiply":
    case "divide":
      return deriveArithmeticType(state, node);
    case "absolute":
    case "round":
    case "clamp": {
      const inputType = requireScalar(
        typeOf(state, node.input as string),
        `node ${node.input}`,
      );
      requireSameDomain(state, node, [node.input as string]);
      if (!isNumeric(inputType.scalar)) {
        fail("type_mismatch", `${node.op} requires a numeric input`);
      }
      return scalarType(
        "decimal",
        inputType.nullable as boolean,
        inputType.unit,
        inputType.currency,
        inputType.grain,
        SCALAR_WIDTHS.decimal,
      );
    }
    case "equal":
    case "not_equal":
    case "less":
    case "less_equal":
    case "greater":
    case "greater_equal": {
      const left = requireScalar(typeOf(state, node.left as string), "left");
      const right = requireScalar(typeOf(state, node.right as string), "right");
      requireSameDomain(state, node, [
        node.left as string,
        node.right as string,
      ]);
      if (
        left.scalar !== right.scalar ||
        left.max_value_bytes !== right.max_value_bytes
      ) {
        fail(
          "type_mismatch",
          "comparison operands must have the identical scalar type",
        );
      }
      if (left.grain !== right.grain) {
        fail(
          "grain_mismatch",
          "comparison operands must have the identical grain",
        );
      }
      if (left.currency !== right.currency) {
        fail(
          "currency_mismatch",
          "comparison operands must have the identical currency",
        );
      }
      if (left.unit !== right.unit) {
        fail(
          "unit_mismatch",
          "comparison operands must have the identical unit",
        );
      }
      if (
        node.op !== "equal" &&
        node.op !== "not_equal" &&
        left.scalar === "boolean"
      ) {
        fail(
          "type_mismatch",
          "ordering comparisons do not accept boolean operands",
        );
      }
      return scalarType(
        "boolean",
        (left.nullable as boolean) || (right.nullable as boolean),
        null,
        null,
        left.grain,
        SCALAR_WIDTHS.boolean,
      );
    }
    case "and":
    case "or": {
      const left = requireScalar(typeOf(state, node.left as string), "left");
      const right = requireScalar(typeOf(state, node.right as string), "right");
      requireSameDomain(state, node, [
        node.left as string,
        node.right as string,
      ]);
      if (left.scalar !== "boolean" || right.scalar !== "boolean") {
        fail("type_mismatch", `${node.op} requires boolean operands`);
      }
      if (left.grain !== right.grain) {
        fail(
          "grain_mismatch",
          `${node.op} operands must have the identical grain`,
        );
      }
      return scalarType(
        "boolean",
        (left.nullable as boolean) || (right.nullable as boolean),
        null,
        null,
        left.grain,
        SCALAR_WIDTHS.boolean,
      );
    }
    case "not": {
      const inputType = requireScalar(
        typeOf(state, node.input as string),
        `node ${node.input}`,
      );
      requireSameDomain(state, node, [node.input as string]);
      if (inputType.scalar !== "boolean") {
        fail("type_mismatch", "not requires a boolean input");
      }
      return scalarType(
        "boolean",
        inputType.nullable as boolean,
        null,
        null,
        inputType.grain,
        SCALAR_WIDTHS.boolean,
      );
    }
    case "if_then_else": {
      const condition = requireScalar(
        typeOf(state, node.condition as string),
        "condition",
      );
      const whenTrue = requireScalar(
        typeOf(state, node.when_true as string),
        "when_true",
      );
      const whenFalse = requireScalar(
        typeOf(state, node.when_false as string),
        "when_false",
      );
      requireSameDomain(state, node, [
        node.condition as string,
        node.when_true as string,
        node.when_false as string,
      ]);
      if (condition.scalar !== "boolean") {
        fail("type_mismatch", "if_then_else requires a boolean condition");
      }
      if (
        whenTrue.scalar !== whenFalse.scalar ||
        whenTrue.max_value_bytes !== whenFalse.max_value_bytes
      ) {
        fail(
          "type_mismatch",
          "if_then_else branches must have the identical typed shape",
        );
      }
      if (whenTrue.grain !== whenFalse.grain) {
        fail(
          "grain_mismatch",
          "if_then_else branches must have the identical grain",
        );
      }
      if (whenTrue.currency !== whenFalse.currency) {
        fail(
          "currency_mismatch",
          "if_then_else branches must have the identical currency",
        );
      }
      if (whenTrue.unit !== whenFalse.unit) {
        fail(
          "unit_mismatch",
          "if_then_else branches must have the identical unit",
        );
      }
      return scalarType(
        whenTrue.scalar as ScalarType,
        (condition.nullable as boolean) ||
          (whenTrue.nullable as boolean) ||
          (whenFalse.nullable as boolean),
        whenTrue.unit,
        whenTrue.currency,
        whenTrue.grain,
        whenTrue.max_value_bytes as bigint,
      );
    }
    case "coalesce": {
      const inputs = node.inputs ?? [];
      const types = inputs.map((id) =>
        requireScalar(typeOf(state, id), `node ${id}`),
      );
      requireSameDomain(state, node, inputs);
      const first = types[0] as OutputType;
      for (const candidate of types) {
        if (
          candidate.scalar !== first.scalar ||
          candidate.max_value_bytes !== first.max_value_bytes
        ) {
          fail(
            "type_mismatch",
            "coalesce inputs must have the identical typed shape",
          );
        }
        if (candidate.grain !== first.grain) {
          fail(
            "grain_mismatch",
            "coalesce inputs must have the identical grain",
          );
        }
        if (candidate.currency !== first.currency) {
          fail(
            "currency_mismatch",
            "coalesce inputs must have the identical currency",
          );
        }
        if (candidate.unit !== first.unit) {
          fail("unit_mismatch", "coalesce inputs must have the identical unit");
        }
      }
      return scalarType(
        first.scalar as ScalarType,
        types.every((candidate) => candidate.nullable === true),
        first.unit,
        first.currency,
        first.grain,
        first.max_value_bytes as bigint,
      );
    }
    case "lag":
    case "delta":
    case "percentage_change": {
      const inputId = node.input as string;
      const inputType = requireScalar(
        typeOf(state, inputId),
        `node ${inputId}`,
      );
      const domain = node.evaluation_rows_from as string;
      requireSameDomain(state, node, [inputId]);
      requireDirectFieldNodes(
        state,
        node,
        node.partition_node_ids ?? [],
        domain,
      );
      requireTotalSortKeys(state, node, domain);
      if (node.op === "lag") return inputType;
      if (!isNumeric(inputType.scalar)) {
        fail("type_mismatch", `${node.op} requires a numeric input`);
      }
      if (node.op === "delta") {
        return scalarType(
          "decimal",
          inputType.nullable as boolean,
          inputType.unit,
          inputType.currency,
          inputType.grain,
          SCALAR_WIDTHS.decimal,
        );
      }
      if (inputType.unit !== null && inputType.currency !== null) {
        fail(
          "unit_mismatch",
          "percentage_change accepts at most one of unit or currency",
        );
      }
      return scalarType(
        "decimal",
        inputType.nullable as boolean,
        "%",
        null,
        inputType.grain,
        SCALAR_WIDTHS.decimal,
      );
    }
    case "window_sum":
    case "window_mean": {
      const inputId = node.input as string;
      const inputType = requireScalar(
        typeOf(state, inputId),
        `node ${inputId}`,
      );
      const domain = node.evaluation_rows_from as string;
      requireSameDomain(state, node, [inputId]);
      requireDirectFieldNodes(
        state,
        node,
        node.partition_node_ids ?? [],
        domain,
      );
      requireTotalSortKeys(state, node, domain);
      if (!isNumeric(inputType.scalar)) {
        fail("type_mismatch", `${node.op} requires a numeric input`);
      }
      return scalarType(
        "decimal",
        false,
        inputType.unit,
        inputType.currency,
        inputType.grain,
        SCALAR_WIDTHS.decimal,
      );
    }
    case "unit_convert": {
      const inputId = node.input as string;
      const inputType = requireScalar(
        typeOf(state, inputId),
        `node ${inputId}`,
      );
      requireSameDomain(state, node, [inputId]);
      if (!isNumeric(inputType.scalar)) {
        fail("type_mismatch", "unit_convert requires a numeric input");
      }
      if (inputType.currency !== null) {
        fail(
          "currency_mismatch",
          "unit_convert forbids a currency-bearing input",
        );
      }
      const from = lookupUnit(node.from_unit);
      const to = lookupUnit(node.to_unit);
      if (from === null || to === null) {
        fail(
          "invalid_unit_conversion",
          "unit_convert names an unknown unit literal",
        );
      }
      if (inputType.unit === null || inputType.unit !== node.from_unit) {
        fail(
          "unit_mismatch",
          "unit_convert from_unit must equal the input unit",
        );
      }
      if (from.dimension !== to.dimension) {
        fail("unit_mismatch", "unit_convert requires one compatible dimension");
      }
      if (node.registry_version !== state.graph.unit_registry_version) {
        fail(
          "invalid_graph",
          "unit_convert registry version differs from the graph",
        );
      }
      return scalarType(
        "decimal",
        inputType.nullable as boolean,
        node.to_unit as string,
        null,
        inputType.grain,
        SCALAR_WIDTHS.decimal,
      );
    }
    case "currency_convert": {
      const inputId = node.input as string;
      const inputType = requireScalar(
        typeOf(state, inputId),
        `node ${inputId}`,
      );
      requireSameDomain(state, node, [inputId]);
      if (!isNumeric(inputType.scalar)) {
        fail("type_mismatch", "currency_convert requires a numeric input");
      }
      if (inputType.unit !== null) {
        fail("unit_mismatch", "currency_convert forbids a unit-bearing input");
      }
      const from = node.from_currency as string;
      const to = node.to_currency as string;
      if (from === to) {
        fail(
          "currency_mismatch",
          "currency_convert requires distinct currencies",
        );
      }
      if (inputType.currency !== from) {
        fail(
          "currency_mismatch",
          "currency_convert from_currency must equal the input",
        );
      }
      const exponent = lookupCurrency(to);
      if (exponent === null) {
        fail("currency_mismatch", "currency_convert names an unknown currency");
      }
      if (node.scale !== exponent) {
        fail(
          "invalid_graph",
          "currency_convert scale must equal the minor-unit exponent",
        );
      }
      if (node.rounding !== "half_even") {
        fail("invalid_graph", "currency_convert rounding must be half_even");
      }
      return scalarType(
        "decimal",
        inputType.nullable as boolean,
        null,
        to,
        inputType.grain,
        SCALAR_WIDTHS.decimal,
      );
    }
    case "classify_state": {
      const inputId = node.input as string;
      const inputType = requireScalar(
        typeOf(state, inputId),
        `node ${inputId}`,
      );
      requireSameDomain(state, node, [inputId]);
      if (inputType.scalar !== "timestamp") {
        fail("type_mismatch", "classify_state requires a timestamp input");
      }
      if (inputType.unit !== null) {
        fail("unit_mismatch", "classify_state input must have a null unit");
      }
      if (inputType.currency !== null) {
        fail(
          "currency_mismatch",
          "classify_state input must have a null currency",
        );
      }
      if (node.evaluation_time !== state.graph.evaluation_time) {
        fail(
          "invalid_graph",
          "classify_state must repeat the exact top-level time",
        );
      }
      return scalarType(
        "text",
        inputType.nullable as boolean,
        null,
        null,
        inputType.grain,
        CLASSIFY_STATE_WIDTH,
      );
    }
  }
}

/** The frozen arithmetic metadata matrix; no dimensional algebra exists. */
function deriveArithmeticType(
  state: DerivationState,
  node: GraphNode,
): OutputType {
  const leftId = node.left as string;
  const rightId = node.right as string;
  const left = requireScalar(typeOf(state, leftId), "left");
  const right = requireScalar(typeOf(state, rightId), "right");
  if (
    domainOf(state, leftId) !== node.evaluation_rows_from ||
    domainOf(state, rightId) !== node.evaluation_rows_from
  ) {
    fail(
      "type_mismatch",
      "arithmetic operand evaluation domains must be identical",
    );
  }
  if (!isNumeric(left.scalar) || !isNumeric(right.scalar)) {
    fail(
      "type_mismatch",
      "arithmetic accepts only integer or decimal operands",
    );
  }
  if (left.grain !== right.grain) {
    fail("grain_mismatch", "arithmetic operand grains must be byte-identical");
  }
  for (const operand of [left, right]) {
    if (operand.unit !== null && operand.currency !== null) {
      fail("unit_mismatch", "no operand may carry both a unit and a currency");
    }
  }
  const nullable = (left.nullable as boolean) || (right.nullable as boolean);
  const bothBare = left.unit === null && right.unit === null;
  const bothCurrencyNull = left.currency === null && right.currency === null;

  if (node.op === "multiply") {
    if (!bothCurrencyNull) {
      fail("currency_mismatch", "multiply forbids currency operands");
    }
    if (!bothBare) fail("unit_mismatch", "multiply forbids unit operands");
    return scalarType(
      "decimal",
      nullable,
      null,
      null,
      left.grain,
      SCALAR_WIDTHS.decimal,
    );
  }

  const sameCurrency =
    left.currency !== null && left.currency === right.currency && bothBare;
  const sameUnit =
    left.unit !== null && left.unit === right.unit && bothCurrencyNull;
  const bareNumbers = bothBare && bothCurrencyNull;

  if (!bareNumbers && !sameCurrency && !sameUnit) {
    if (left.currency !== right.currency) {
      fail("currency_mismatch", "unlike currency arithmetic is rejected");
    }
    fail("unit_mismatch", "unlike or unlisted unit arithmetic is rejected");
  }
  if (sameUnit) {
    const entry = lookupUnit(left.unit);
    if (entry === null || entry.affine) {
      fail("unit_mismatch", "affine units may not participate in arithmetic");
    }
  }
  if (node.op === "divide") {
    return scalarType(
      "decimal",
      nullable,
      "1",
      null,
      left.grain,
      SCALAR_WIDTHS.decimal,
    );
  }
  return scalarType(
    "decimal",
    nullable,
    sameUnit ? left.unit : null,
    sameCurrency ? left.currency : null,
    left.grain,
    SCALAR_WIDTHS.decimal,
  );
}

/* ------------------------------------------------------------------ *
 * Static cardinality, bytes, and meters
 * ------------------------------------------------------------------ */

function computeUpperRows(
  state: DerivationState,
  order: readonly GraphNode[],
  catalog: FieldCatalogSnapshot,
): ReadonlyMap<string, bigint> {
  const upper = new Map<string, bigint>();
  const sourceBound =
    catalog.input_row_count < LIMITS.scannedRows
      ? catalog.input_row_count
      : LIMITS.scannedRows;
  for (const node of order) {
    if (ROWSET_OPS.has(node.op)) {
      switch (node.op) {
        case "source":
          upper.set(node.node_id, sourceBound);
          break;
        case "group": {
          const inputRows = upper.get(node.input as string) as bigint;
          const keyCount = (node.key_node_ids ?? []).length;
          upper.set(
            node.node_id,
            keyCount === 0
              ? 1n
              : inputRows < LIMITS.groups
                ? inputRows
                : LIMITS.groups,
          );
          break;
        }
        case "top_k": {
          const inputRows = upper.get(node.input as string) as bigint;
          const q = node.k as bigint;
          upper.set(node.node_id, inputRows < q ? inputRows : q);
          break;
        }
        default:
          upper.set(node.node_id, upper.get(node.input as string) as bigint);
      }
    } else {
      upper.set(
        node.node_id,
        upper.get(node.evaluation_rows_from as string) as bigint,
      );
    }
  }
  void state;
  return upper;
}

const MAX_ORDINAL_TEXT = `i64:${I64_MAX.toString(10)}`;
const PLACEHOLDER_UUID = "00000000-0000-8000-8000-000000000000";

/** `{"state":"present","type":"<t>","value":` plus the closing brace. */
function valueTokenShellBytes(type: ScalarType): bigint {
  return utf8ByteLength(`{"state":"present","type":"${type}","value":}`);
}

const ROWSET_ROW_SHELL_BYTES = utf8ByteLength(
  `{"cells":[],"ordinal":"${MAX_ORDINAL_TEXT}","row_id":"${PLACEHOLDER_UUID}"}`,
);

const CELL_SHELL_BYTES = utf8ByteLength(
  `{"field_id":"${PLACEHOLDER_UUID}","value":}`,
);

const SCALAR_ROW_SHELL_BYTES = utf8ByteLength(
  `{"ordinal":"${MAX_ORDINAL_TEXT}","row_id":"${PLACEHOLDER_UUID}","value":}`,
);

/**
 * The canonical byte length of one maximal tagged value of scalar `t` at the
 * declared width, computed arithmetically rather than by materializing a filler.
 *
 * A declared `max_value_bytes` is an untrusted tagged `i64`, so it is compared
 * against the limits object in `bigint` before anything derives from it. Routing
 * it through `Number()` — as a filler `String.repeat` would — loses precision
 * above 2^53 and raises a host `RangeError` well before any meter could report
 * the deterministic `limit_exceeded`. After this gate no allocation is sized by
 * the width at all: a value token is exactly its shell plus `width` bytes.
 */
function maximalValueTokenBytes(type: ScalarType, width: bigint): bigint {
  if (width > MAX_DECLARED_VALUE_BYTES) {
    fail(
      "limit_exceeded",
      `declared max_value_bytes ${width} exceeds ${MAX_DECLARED_VALUE_BYTES}`,
    );
  }
  return checkedSum([valueTokenShellBytes(type), width]);
}

/** The canonical byte length of one maximal row of the derived output type. */
function maximalRowBytes(derived: OutputType): bigint {
  if (derived.shape !== "rowset") {
    return checkedSum([
      SCALAR_ROW_SHELL_BYTES,
      maximalValueTokenBytes(
        derived.scalar as ScalarType,
        derived.max_value_bytes as bigint,
      ),
    ]);
  }
  const fields = derived.fields ?? [];
  const parts: bigint[] = [ROWSET_ROW_SHELL_BYTES];
  for (const field of fields) {
    parts.push(
      CELL_SHELL_BYTES,
      maximalValueTokenBytes(field.scalar, field.max_value_bytes),
    );
  }
  // One separator between adjacent cells.
  if (fields.length > 0) parts.push(BigInt(fields.length - 1));
  return checkedSum(parts);
}

function staticNodeBytes(
  node: GraphNode,
  derived: OutputType,
  rows: bigint,
): bigint {
  const encodedType = jcsEncode(encodeOutputType(derived));
  const rowBytes = maximalRowBytes(derived);
  if (derived.shape === "rowset") {
    const header = utf8ByteLength(
      `{"node_id":"${PLACEHOLDER_UUID}","output_type":${encodedType},"rows":[],"schema":"calculation-node-rowset-v1"}`,
    );
    if (rows === 0n) return header;
    return checkedSum([header, checkedProduct(rows, rowBytes), rows - 1n]);
  }
  const header = utf8ByteLength(
    `{"evaluation_rows_from":"${PLACEHOLDER_UUID}","node_id":"${PLACEHOLDER_UUID}","output_type":${encodedType},"rows":[],"schema":"calculation-node-scalar-v1"}`,
  );
  void node;
  if (rows === 0n) return header;
  return checkedSum([header, checkedProduct(rows, rowBytes), rows - 1n]);
}

function staticOutputEntryBytes(
  node: GraphNode,
  derived: OutputType,
  rows: bigint,
): bigint {
  const encodedType = jcsEncode(encodeOutputType(derived));
  const isRowset = derived.shape === "rowset";
  const rowBytes = maximalRowBytes(derived);
  const header = utf8ByteLength(
    `{"cardinality":"${MAX_ORDINAL_TEXT}","evaluation_rows_from":${
      isRowset ? "null" : `"${PLACEHOLDER_UUID}"`
    },"node_id":"${PLACEHOLDER_UUID}","output_type":${encodedType},"rows":[],"shape":"${
      derived.shape
    }"}`,
  );
  void node;
  if (rows === 0n) return header;
  return checkedSum([header, checkedProduct(rows, rowBytes), rows - 1n]);
}

function literalBytes(value: RuntimeValue): bigint {
  return utf8ByteLength(jcsEncode(encodeTypedValue(value)));
}

function decimalScaleAndDigits(value: CanonicalDecimal): {
  scale: bigint;
  digits: bigint;
} {
  return { scale: value.scale, digits: coefficientDigits(value.coefficient) };
}

function computeStaticMeter(
  state: DerivationState,
  order: readonly GraphNode[],
  input: CanonicalInputTable,
  upperRows: ReadonlyMap<string, bigint>,
): StaticMeter {
  const finalIds = new Set(state.graph.output_node_ids);
  let maxDepth = 0n;
  const depths = new Map<string, bigint>();
  for (const node of order) {
    let depth = 1n;
    for (const reference of referencedNodeIds(node)) {
      const candidate = (depths.get(reference) as bigint) + 1n;
      if (candidate > depth) depth = candidate;
    }
    depths.set(node.node_id, depth);
    if (depth > maxDepth) maxDepth = depth;
  }

  let maxLiteralBytes = 0n;
  let totalLiteralBytes = 0n;
  let maxTopK = 0n;
  let maxWindowFrame = 0n;
  let maxScale = 0n;
  let maxDigits = 0n;
  let scannedRows = 0n;
  let groupCount = 0n;
  let maxGroupRows = 0n;
  let intermediateRows = 0n;
  let finalRows = 0n;
  let intermediateBytes = 0n;
  let outputBytes = 0n;
  let steps = 0n;

  const literals: RuntimeValue[] = [];
  for (const node of order) {
    if (node.literal !== undefined) literals.push(node.literal);
    if (node.minimum !== undefined) literals.push(node.minimum);
    if (node.maximum !== undefined) literals.push(node.maximum);
    if (node.scale !== undefined && node.scale > maxScale)
      maxScale = node.scale;
    if (node.rate !== undefined) {
      const { scale, digits } = decimalScaleAndDigits(node.rate);
      if (scale > maxScale) maxScale = scale;
      if (digits > maxDigits) maxDigits = digits;
    }
    if (node.k !== undefined && node.k > maxTopK) maxTopK = node.k;
    if (node.preceding !== undefined && node.following !== undefined) {
      const width = 1n + node.preceding + node.following;
      if (width > maxWindowFrame) maxWindowFrame = width;
    }
  }
  for (const literal of literals) {
    const bytes = literalBytes(literal);
    if (bytes > maxLiteralBytes) maxLiteralBytes = bytes;
    totalLiteralBytes = checkedSum([totalLiteralBytes, bytes]);
    if (literal.type === "decimal" && literal.value !== null) {
      const { scale, digits } = decimalScaleAndDigits(
        literal.value as CanonicalDecimal,
      );
      if (scale > maxScale) maxScale = scale;
      if (digits > maxDigits) maxDigits = digits;
    }
  }
  for (const row of input.rows) {
    for (const value of row.values.values()) {
      if (value.type === "decimal" && value.value !== null) {
        const { scale, digits } = decimalScaleAndDigits(
          value.value as CanonicalDecimal,
        );
        if (scale > maxScale) maxScale = scale;
        if (digits > maxDigits) maxDigits = digits;
      }
    }
  }

  for (const node of order) {
    const derived = state.derived.get(node.node_id) as OutputType;
    const rows = upperRows.get(node.node_id) as bigint;
    if (node.op === "source") scannedRows = checkedSum([scannedRows, rows]);
    if (node.op === "group") {
      if (rows > groupCount) groupCount = rows;
      const inputRows = upperRows.get(node.input as string) as bigint;
      if (inputRows > maxGroupRows) maxGroupRows = inputRows;
    }
    if (finalIds.has(node.node_id)) {
      finalRows = checkedSum([finalRows, rows]);
      outputBytes = checkedSum([
        outputBytes,
        staticOutputEntryBytes(node, derived, rows),
      ]);
    } else {
      intermediateRows = checkedSum([intermediateRows, rows]);
      intermediateBytes = checkedSum([
        intermediateBytes,
        staticNodeBytes(node, derived, rows),
      ]);
    }
    steps = checkedSum([steps, staticStepCharge(state, node, upperRows)]);
  }

  // The outputs array adds its brackets and one separator per extra entry.
  const outputEntryCount = BigInt(state.graph.output_node_ids.length);
  outputBytes = checkedSum([outputBytes, 2n, outputEntryCount - 1n]);

  const nodeCount = BigInt(order.length);
  const logical = checkedSum([
    input.canonicalBytes,
    state.graph.canonicalBytes,
    intermediateBytes,
    outputBytes,
    checkedProduct(64n, nodeCount),
  ]);

  return {
    input_bytes: input.canonicalBytes,
    ast_bytes: state.graph.canonicalBytes,
    node_count: nodeCount,
    max_depth: maxDepth,
    max_literal_bytes: maxLiteralBytes,
    total_literal_bytes: totalLiteralBytes,
    max_literal_list_length: 0n,
    scanned_rows: scannedRows,
    group_count: groupCount,
    max_group_rows: maxGroupRows,
    cumulative_intermediate_rows: intermediateRows,
    final_output_rows: finalRows,
    cumulative_intermediate_bytes: intermediateBytes,
    output_bytes: outputBytes,
    primitive_steps: steps,
    logical_allocation_bytes: logical,
    max_top_k: maxTopK,
    max_window_frame: maxWindowFrame,
    max_coefficient_digits: maxDigits,
    max_scale: maxScale,
  };
}

function staticStepCharge(
  state: DerivationState,
  node: GraphNode,
  upperRows: ReadonlyMap<string, bigint>,
): bigint {
  const counts = stepCountsFor(state, node, upperRows);
  return primitiveStepCharge(node.op as Op, counts);
}

function stepCountsFor(
  state: DerivationState,
  node: GraphNode,
  upperRows: ReadonlyMap<string, bigint>,
): StepCounts {
  const domainId = ROWSET_OPS.has(node.op)
    ? node.op === "source"
      ? node.node_id
      : (node.input as string)
    : (node.evaluation_rows_from as string);
  let n = upperRows.get(domainId) as bigint;
  if (GROUPED_AGGREGATE_OPS.has(node.op)) {
    const groupNode = state.nodesById.get(
      node.group_node_id as string,
    ) as GraphNode;
    n = upperRows.get(groupNode.input as string) as bigint;
  }
  const g = node.op === "group" ? (upperRows.get(node.node_id) as bigint) : 0n;
  return {
    n,
    g,
    gk: BigInt((node.key_node_ids ?? []).length),
    sk: BigInt((node.keys ?? []).length),
    pk: BigInt((node.partition_node_ids ?? []).length),
    q: node.k ?? 0n,
    s: state.sortCertificates.get(node.input ?? "") ?? 0n,
    a: BigInt((node.inputs ?? []).length),
    p: BigInt((node.projections ?? []).length),
    w:
      node.preceding !== undefined && node.following !== undefined
        ? 1n + node.preceding + node.following
        : 0n,
  };
}

/** Every ceiling is inclusive; the first unit above it denies before evaluation. */
export function requireLimits(meter: StaticMeter): void {
  const checks: ReadonlyArray<readonly [bigint, bigint, string]> = [
    [meter.input_bytes, LIMITS.canonicalInputBytes, "input_bytes"],
    [meter.ast_bytes, LIMITS.astBytes, "ast_bytes"],
    [meter.node_count, LIMITS.nodeCount, "node_count"],
    [meter.max_depth, LIMITS.maxDepth, "max_depth"],
    [meter.max_literal_bytes, LIMITS.literalBytes, "max_literal_bytes"],
    [
      meter.total_literal_bytes,
      LIMITS.totalLiteralBytes,
      "total_literal_bytes",
    ],
    [
      meter.max_literal_list_length,
      LIMITS.literalListLength,
      "max_literal_list_length",
    ],
    [meter.scanned_rows, LIMITS.scannedRows, "scanned_rows"],
    [meter.group_count, LIMITS.groups, "group_count"],
    [meter.max_group_rows, LIMITS.rowsInGroup, "max_group_rows"],
    [
      meter.cumulative_intermediate_rows,
      LIMITS.cumulativeIntermediateRows,
      "cumulative_intermediate_rows",
    ],
    [meter.final_output_rows, LIMITS.finalOutputRows, "final_output_rows"],
    [
      meter.cumulative_intermediate_bytes,
      LIMITS.cumulativeIntermediateBytes,
      "cumulative_intermediate_bytes",
    ],
    [meter.output_bytes, LIMITS.outputBytes, "output_bytes"],
    [meter.primitive_steps, LIMITS.primitiveSteps, "primitive_steps"],
    [
      meter.logical_allocation_bytes,
      LIMITS.logicalAllocationBytes,
      "logical_allocation_bytes",
    ],
    [meter.max_top_k, LIMITS.topK, "max_top_k"],
    [meter.max_window_frame, LIMITS.windowFrame, "max_window_frame"],
    [
      meter.max_coefficient_digits,
      LIMITS.coefficientDigits,
      "max_coefficient_digits",
    ],
    [meter.max_scale, LIMITS.scale, "max_scale"],
  ];
  for (const [value, ceiling, name] of checks) {
    if (value < 0n) fail("limit_exceeded", `${name} must be nonnegative`);
    if (value > ceiling)
      fail("limit_exceeded", `${name} exceeds its inclusive ceiling`);
  }
}

/* ------------------------------------------------------------------ *
 * FX evidence binding
 * ------------------------------------------------------------------ */

function validateFxBinding(
  options: ValidateOptions,
  state: DerivationState,
): FxRateEvidence | null {
  const { graph, bundle, fxEvidence } = options;
  const converts = graph.nodes.filter((node) => node.op === "currency_convert");
  if (converts.length === 0) {
    if (graph.fx_evidence_id !== null || graph.fx_evidence_sha256 !== null) {
      fail(
        "invalid_graph",
        "FX identity requires at least one currency_convert node",
      );
    }
    return null;
  }
  if (graph.fx_evidence_id === null || graph.fx_evidence_sha256 === null) {
    fail(
      "missing_fx_evidence",
      "currency_convert requires the graph FX identity",
    );
  }
  const pairs = new Set(
    converts.map((node) => `${node.from_currency}/${node.to_currency}`),
  );
  const rates = new Set(
    converts.map((node) => {
      const rate = node.rate as CanonicalDecimal;
      return `${rate.coefficient.toString(10)}e${rate.scale.toString(10)}`;
    }),
  );
  if (pairs.size !== 1 || rates.size !== 1) {
    fail("missing_fx_evidence", "a graph cannot carry two FX pairs or rates");
  }
  for (const node of converts) {
    if (node.fx_evidence_id !== graph.fx_evidence_id) {
      fail(
        "missing_fx_evidence",
        "every currency_convert must repeat the graph FX ID",
      );
    }
  }
  if (bundle === undefined || fxEvidence === undefined) {
    fail(
      "missing_fx_evidence",
      "the bound FX evidence row and bundle are required",
    );
  }
  if (bundle.bundle_id !== graph.common_bundle_id) {
    fail(
      "missing_fx_evidence",
      "bundle identity differs from the graph binding",
    );
  }
  if (bundle.bundle_sha256 !== graph.common_bundle_sha256) {
    fail("missing_fx_evidence", "bundle hash differs from the graph binding");
  }
  const entry = bundle.entries.find(
    (candidate) => candidate.evidence_id === graph.fx_evidence_id,
  );
  if (entry === undefined) {
    fail(
      "missing_fx_evidence",
      "the FX evidence row is absent from the common bundle",
    );
  }
  if (entry.evidence_sha256 !== graph.fx_evidence_sha256) {
    fail(
      "missing_fx_evidence",
      "bundle evidence hash differs from the graph binding",
    );
  }
  if (fxEvidence.evidence_sha256 !== graph.fx_evidence_sha256) {
    fail(
      "missing_fx_evidence",
      "the FX body hash differs from the bound identity",
    );
  }
  if (entry.source_snapshot_id !== graph.input_snapshot_id) {
    fail("missing_fx_evidence", "the FX entry names another source snapshot");
  }
  if (entry.source_sha256 !== graph.input_sha256) {
    fail("missing_fx_evidence", "the FX entry names another source hash");
  }
  const node = converts[0] as GraphNode;
  if (
    fxEvidence.from_currency !== node.from_currency ||
    fxEvidence.to_currency !== node.to_currency
  ) {
    fail(
      "missing_fx_evidence",
      "the FX body direction differs from the node direction",
    );
  }
  const rate = node.rate as CanonicalDecimal;
  if (
    fxEvidence.rate.coefficient !== rate.coefficient ||
    fxEvidence.rate.scale !== rate.scale
  ) {
    fail("missing_fx_evidence", "the FX body rate differs from the node rate");
  }
  if (fxEvidence.observed_at !== entry.observed_at) {
    fail(
      "missing_fx_evidence",
      "the FX body instant differs from the bundle entry",
    );
  }
  const lineage = lineageUnion(options, state);
  if (!lineage.has(graph.fx_evidence_id)) {
    fail(
      "missing_fx_evidence",
      "the FX evidence is outside the request lineage union",
    );
  }

  // Only a complete identity contract can reach the freshness cutoff.
  if (entry.freshness !== "current") {
    fail("stale_fx", "the FX bundle entry is not labelled current");
  }
  if (fxEvidence.observed_micros > graph.evaluation_micros) {
    fail("stale_fx", "the FX evidence instant is after the evaluation time");
  }
  const ageMillis =
    (graph.evaluation_micros - fxEvidence.observed_micros) / 1000n;
  const remainder =
    (graph.evaluation_micros - fxEvidence.observed_micros) % 1000n;
  if (
    ageMillis > FX_MAX_AGE_MILLIS ||
    (ageMillis === FX_MAX_AGE_MILLIS && remainder > 0n)
  ) {
    fail(
      "stale_fx",
      "the FX evidence is beyond the fixed inclusive age cutoff",
    );
  }
  return fxEvidence;
}

function lineageUnion(
  options: ValidateOptions,
  state: DerivationState,
): ReadonlySet<string> {
  const union = new Set<string>();
  for (const field of state.catalog.fields) {
    for (const id of field.lineage_evidence_ids) union.add(id);
  }
  for (const contract of options.contractSet?.contracts ?? []) {
    for (const id of contract.lineage_evidence_ids) union.add(id);
  }
  return union;
}

/* ------------------------------------------------------------------ *
 * Freshness diagnostic trio
 * ------------------------------------------------------------------ */

function deriveFreshnessTrio(
  state: DerivationState,
  order: readonly GraphNode[],
): FreshnessTrio | null {
  const classifiers = order.filter((node) => node.op === "classify_state");
  const matches: FreshnessTrio[] = [];
  for (const classifier of classifiers) {
    const maxNode = state.nodesById.get(classifier.input as string);
    if (maxNode === undefined || maxNode.op !== "max") continue;
    const group = state.nodesById.get(maxNode.group_node_id as string);
    if (group === undefined || group.op !== "group") continue;
    if ((group.key_node_ids ?? []).length !== 0) continue;
    const field = state.nodesById.get(maxNode.input as string);
    if (field === undefined || field.op !== "field") continue;
    if (!state.graph.output_node_ids.includes(classifier.node_id)) continue;
    matches.push({
      classifier_node_id: classifier.node_id,
      input_node_id: maxNode.node_id,
    });
  }
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    fail("invalid_graph", "two matching freshness structures are not admitted");
  }
  return matches[0] as FreshnessTrio;
}

/* ------------------------------------------------------------------ *
 * MetricContractVersion conformance
 * ------------------------------------------------------------------ */

const GRAPH_CAPABLE_AGGREGATIONS = [
  "count",
  "sum",
  "min",
  "max",
  "mean",
  "ratio",
];

function validateContractConformance(
  options: ValidateOptions,
  state: DerivationState,
  contract: MetricContractVersion,
  order: readonly GraphNode[],
  freshness: FreshnessTrio | null,
): void {
  const { graph, catalog } = state;

  // Cross-field validity.
  if (contract.review_state !== "reviewed") {
    fail("invalid_graph", "the bound contract is not reviewed");
  }
  if (
    contract.business_owner_membership_id === contract.data_owner_membership_id
  ) {
    fail(
      "invalid_graph",
      "business and data owners must be distinct memberships",
    );
  }
  if (contract.aggregation === "ratio") {
    if (
      contract.denominator_contract_id === null ||
      contract.denominator_contract_version === null
    ) {
      fail("invalid_graph", "ratio requires both denominator fields");
    }
  } else if (
    contract.denominator_contract_id !== null ||
    contract.denominator_contract_version !== null
  ) {
    fail("invalid_graph", "only ratio may carry denominator fields");
  }
  if (!GRAPH_CAPABLE_AGGREGATIONS.includes(contract.aggregation)) {
    fail("invalid_graph", "the bound aggregation is not graph-capable");
  }
  if (contract.allowed_dimension_field_ids.length > 16) {
    fail(
      "invalid_graph",
      "a contract beyond 16 dimensions cannot reach the registry",
    );
  }
  const sum = checkedAdd(contract.lag_millis, contract.freshness_slo_millis);
  if (sum === null)
    fail("invalid_graph", "lag plus SLO must fit signed 64 bits");

  const measure = catalog.fields.find(
    (field) => field.field_id === contract.measure_field_id,
  );
  if (measure === undefined) {
    fail("missing_field", "the contract measure is absent from the catalog");
  }
  if (measure.semantic_type !== "measure") {
    fail("invalid_graph", "the contract measure is not a catalog measure");
  }
  if (!measure.allowed_aggregations.includes(contract.aggregation)) {
    fail(
      "invalid_graph",
      "the measure does not allow the contract aggregation",
    );
  }
  if (measure.event_time_field_id === null) {
    fail("invalid_graph", "the contract measure has no event-time field");
  }
  const eventTime = catalog.fields.find(
    (field) => field.field_id === measure.event_time_field_id,
  );
  if (eventTime === undefined || eventTime.semantic_type !== "event_time") {
    fail(
      "invalid_graph",
      "the measure event-time entry is not an event_time field",
    );
  }
  if (eventTime.scalar_type !== "timestamp") {
    fail("type_mismatch", "the measure event-time field must be a timestamp");
  }
  for (const dimensionId of contract.allowed_dimension_field_ids) {
    const dimension = catalog.fields.find(
      (field) => field.field_id === dimensionId,
    );
    if (dimension === undefined) {
      fail("missing_field", "an allowed dimension is absent from the catalog");
    }
    if (
      dimension.semantic_type !== "dimension" &&
      dimension.semantic_type !== "identifier"
    ) {
      fail(
        "invalid_graph",
        "an allowed dimension is not a dimension or identifier",
      );
    }
    if (!measure.allowed_dimensions.includes(dimensionId)) {
      fail(
        "invalid_graph",
        "an allowed dimension is not listed on the measure",
      );
    }
  }

  // Derived grain, calendar, and timezone.
  const derivedGrain = deriveGroupGrain(
    contract.calendar,
    contract.timezone,
    contract.allowed_dimension_field_ids,
  );
  if (contract.grain !== derivedGrain) {
    fail(
      "grain_mismatch",
      "the contract grain is not the derived hashed group grain",
    );
  }

  // Value-type pairings.
  validateValueTypeMapping(contract, measure);

  // Direction, threshold, and target.
  validateDirection(contract);

  // Graph mapping.
  const outputNode = state.nodesById.get(
    graph.contract_output_node_id,
  ) as GraphNode;
  if (!graph.output_node_ids.includes(graph.contract_output_node_id)) {
    fail("invalid_graph", "contract_output_node_id must be a graph output");
  }
  const outputType = state.derived.get(outputNode.node_id) as OutputType;
  validateContractOutputMetadata(contract, outputType);

  const aggregate = walkContractPath(state, outputNode, contract);
  const groupNode = state.nodesById.get(
    aggregate.group_node_id as string,
  ) as GraphNode;
  const groupFieldIds = (groupNode.key_node_ids ?? []).map(
    (id) => (state.nodesById.get(id) as GraphNode).field_id as string,
  );
  const sortedGroupFieldIds = [...groupFieldIds].sort(compareUtf8);
  if (
    sortedGroupFieldIds.join(",") !==
    [...contract.allowed_dimension_field_ids].join(",")
  ) {
    fail(
      "invalid_graph",
      "the contract group keys must equal its allowed dimensions",
    );
  }

  validateThresholdAndTargetNodes(state, contract);
  validateContractFreshness(
    options,
    state,
    contract,
    order,
    freshness,
    measure,
  );
}

function validateValueTypeMapping(
  contract: MetricContractVersion,
  measure: CatalogField,
): void {
  const { value_type: valueType, unit, currency, aggregation } = contract;
  if (aggregation === "count" || aggregation === "count_distinct") {
    if (valueType !== "integer" || unit !== null || currency !== null) {
      fail(
        "type_mismatch",
        "count contracts require integer with null unit/currency",
      );
    }
    return;
  }
  if (aggregation === "ratio") {
    const decimalRatio = valueType === "decimal" && unit === "1";
    const percentageRatio = valueType === "percentage" && unit === "%";
    if ((!decimalRatio && !percentageRatio) || currency !== null) {
      fail(
        "type_mismatch",
        "ratio requires decimal unit 1 or percentage unit %",
      );
    }
    return;
  }
  if (aggregation === "sum" || aggregation === "mean") {
    if (!["integer", "decimal"].includes(measure.scalar_type)) {
      fail("type_mismatch", "sum and mean require a numeric measure");
    }
  }
  if (aggregation === "min" || aggregation === "max") {
    if (measure.scalar_type !== "decimal") {
      fail("type_mismatch", "a min or max contract requires a decimal measure");
    }
  }
  if (valueType === "currency") {
    if (currency === null || unit !== null) {
      fail(
        "currency_mismatch",
        "a currency contract requires one currency and no unit",
      );
    }
    return;
  }
  if (valueType === "percentage") {
    if (unit !== "%" || currency !== null) {
      fail(
        "unit_mismatch",
        "a percentage contract requires unit % and null currency",
      );
    }
    return;
  }
  if (valueType === "duration") {
    const entry = unit === null ? null : lookupUnit(unit);
    if (entry === null || entry.dimension !== "duration" || currency !== null) {
      fail(
        "unit_mismatch",
        "a duration contract requires a duration-dimension unit",
      );
    }
    return;
  }
  if (valueType === "decimal") {
    if (currency !== null) {
      fail("currency_mismatch", "a decimal contract requires a null currency");
    }
    if (unit === "%") {
      fail("unit_mismatch", "a decimal contract may not use unit %");
    }
    return;
  }
  fail("type_mismatch", "unsupported aggregation and value-type pairing");
}

function validateDirection(contract: MetricContractVersion): void {
  const { direction, threshold, target } = contract;
  if (direction === "neutral") {
    if (threshold !== null || target !== null) {
      fail("invalid_graph", "neutral requires null threshold and target");
    }
    return;
  }
  if (threshold === null || target === null) {
    fail("invalid_graph", `${direction} requires both threshold and target`);
  }
  const thresholdValue = parseContractDecimalText(threshold, "threshold").value;
  const targetValue = parseContractDecimalText(target, "target").value;
  const compare =
    thresholdValue.n * targetValue.d - targetValue.n * thresholdValue.d;
  if (direction === "higher_is_better" && compare > 0n) {
    fail("invalid_graph", "higher_is_better requires target >= threshold");
  }
  if (direction === "lower_is_better" && compare < 0n) {
    fail("invalid_graph", "lower_is_better requires target <= threshold");
  }
  if (direction === "target_band" && compare > 0n) {
    fail("invalid_graph", "target_band requires threshold <= target");
  }
}

function validateContractOutputMetadata(
  contract: MetricContractVersion,
  outputType: OutputType,
): void {
  if (outputType.shape !== "scalar") {
    fail("type_mismatch", "the contract output must be a scalar");
  }
  const expectedScalar =
    contract.value_type === "integer" ? "integer" : "decimal";
  if (outputType.scalar !== expectedScalar) {
    fail(
      "type_mismatch",
      "the contract output scalar differs from the value type",
    );
  }
  if (outputType.grain !== contract.grain) {
    fail(
      "grain_mismatch",
      "the contract output grain differs from the contract grain",
    );
  }
  if (outputType.currency !== contract.currency) {
    fail(
      "currency_mismatch",
      "the contract output currency differs from the contract",
    );
  }
  if (outputType.unit !== contract.unit) {
    fail("unit_mismatch", "the contract output unit differs from the contract");
  }
}

/**
 * Walks back from the contract output through at most one final conversion to the
 * aggregation node. No filter, sort, top-k, lag, window, conditional, or other
 * uncontracted selection may sit on this path.
 */
function walkContractPath(
  state: DerivationState,
  outputNode: GraphNode,
  contract: MetricContractVersion,
): GraphNode {
  let current = outputNode;
  let conversions = 0;
  while (current.op === "unit_convert" || current.op === "currency_convert") {
    conversions += 1;
    if (conversions > 1) {
      fail(
        "invalid_graph",
        "at most one final conversion may follow the aggregation",
      );
    }
    if (current.op === "unit_convert") {
      if (current.scale !== 18n || current.rounding !== "half_even") {
        fail(
          "invalid_graph",
          "contract unit conversion uses scale i64:18 and half_even",
        );
      }
    }
    current = state.nodesById.get(current.input as string) as GraphNode;
  }
  const expected =
    contract.aggregation === "count" ? "count_present" : contract.aggregation;
  if (contract.aggregation === "ratio") {
    if (current.op !== "divide") {
      fail("invalid_graph", "a ratio contract must terminate in one divide");
    }
    if (current.scale !== 18n || current.rounding !== "half_even") {
      fail("invalid_graph", "a ratio divide uses scale i64:18 and half_even");
    }
    const numerator = state.nodesById.get(current.left as string) as GraphNode;
    const denominator = state.nodesById.get(
      current.right as string,
    ) as GraphNode;
    if (numerator.op !== "sum" || denominator.op !== "sum") {
      fail("invalid_graph", "a ratio requires a numerator and denominator sum");
    }
    if (numerator.group_node_id !== denominator.group_node_id) {
      fail("invalid_graph", "both ratio sums must share the same group node");
    }
    return numerator;
  }
  if (current.op !== expected) {
    fail(
      "invalid_graph",
      "the contract path does not terminate in its aggregation",
    );
  }
  if (contract.aggregation === "mean") {
    if (current.scale !== 18n || current.rounding !== "half_even") {
      fail("invalid_graph", "a mean contract uses scale i64:18 and half_even");
    }
  }
  return current;
}

function validateThresholdAndTargetNodes(
  state: DerivationState,
  contract: MetricContractVersion,
): void {
  const { graph } = state;
  if (contract.direction === "neutral") {
    if (graph.threshold_node_id !== null || graph.target_node_id !== null) {
      fail(
        "invalid_graph",
        "neutral requires both graph threshold IDs to be null",
      );
    }
    return;
  }
  if (graph.threshold_node_id === null || graph.target_node_id === null) {
    fail(
      "invalid_graph",
      "a directional contract requires both graph threshold IDs",
    );
  }
  if (graph.threshold_node_id === graph.target_node_id) {
    fail(
      "invalid_graph",
      "threshold and target must name distinct comparison nodes",
    );
  }
  const expected =
    contract.direction === "higher_is_better"
      ? { threshold: "greater_equal", target: "greater_equal" }
      : contract.direction === "lower_is_better"
        ? { threshold: "less_equal", target: "less_equal" }
        : { threshold: "greater_equal", target: "less_equal" };
  const pairs = [
    [graph.threshold_node_id, expected.threshold, contract.threshold] as const,
    [graph.target_node_id, expected.target, contract.target] as const,
  ];
  const literalIds = new Set<string>();
  for (const [nodeId, op, text] of pairs) {
    const comparison = state.nodesById.get(nodeId) as GraphNode;
    if (comparison.op !== op) {
      fail(
        "invalid_graph",
        "the comparison operation does not match the direction",
      );
    }
    if (comparison.left !== graph.contract_output_node_id) {
      fail(
        "invalid_graph",
        "the comparison left input must be the contract output",
      );
    }
    if (!graph.output_node_ids.includes(nodeId)) {
      fail(
        "invalid_graph",
        "each threshold and target node must be a graph output",
      );
    }
    const literalId = comparison.right as string;
    if (literalIds.has(literalId)) {
      fail(
        "invalid_graph",
        "threshold and target must use distinct literal nodes",
      );
    }
    literalIds.add(literalId);
    const literalNode = state.nodesById.get(literalId) as GraphNode;
    if (literalNode.op !== "literal") {
      fail(
        "invalid_graph",
        "the comparison right input must be a present literal",
      );
    }
    const consumers = state.graph.nodes.filter((candidate) =>
      referencedNodeIds(candidate).includes(literalId),
    );
    if (consumers.length !== 1) {
      fail(
        "invalid_graph",
        "a contextual literal may have only its named comparison",
      );
    }
    const literal = literalNode.literal as RuntimeValue;
    if (text === null) fail("invalid_graph", "the contract bound is null");
    const bound = parseContractDecimalText(text, "bound").value;
    const literalRational =
      literal.type === "integer"
        ? { n: literal.value as bigint, d: 1n }
        : {
            n: (literal.value as CanonicalDecimal).coefficient,
            d: 10n ** (literal.value as CanonicalDecimal).scale,
          };
    if (bound.n * literalRational.d !== literalRational.n * bound.d) {
      fail(
        "invalid_graph",
        "the contextual literal does not encode the contract bound",
      );
    }
  }
}

function validateContractFreshness(
  options: ValidateOptions,
  state: DerivationState,
  contract: MetricContractVersion,
  order: readonly GraphNode[],
  freshness: FreshnessTrio | null,
  measure: CatalogField,
): void {
  const { graph, catalog } = state;
  const allowanceMicros = checkedProduct(
    checkedAdd(contract.lag_millis, contract.freshness_slo_millis) as bigint,
    1000n,
  );
  const checkInstant = (observed: bigint, what: string): void => {
    if (observed > graph.evaluation_micros) {
      fail("invalid_graph", `${what} is later than the evaluation time`);
    }
    if (graph.evaluation_micros - observed > allowanceMicros) {
      fail("invalid_graph", `${what} exceeds the checked lag plus SLO`);
    }
  };
  checkInstant(catalog.evaluated_micros, "the catalog evaluation instant");
  const bundle = options.bundle;
  if (bundle !== undefined) {
    for (const id of contract.lineage_evidence_ids) {
      const entry = bundle.entries.find(
        (candidate) => candidate.evidence_id === id,
      );
      if (entry === undefined) {
        fail(
          "missing_field",
          "a contract lineage evidence row is absent from the bundle",
        );
      }
      if (entry.source_snapshot_id !== graph.input_snapshot_id) {
        fail("invalid_graph", "a lineage entry names another source snapshot");
      }
      if (entry.freshness !== "current") {
        fail("invalid_graph", "a lineage entry is not labelled current");
      }
      checkInstant(entry.observed_micros, "a lineage evidence instant");
    }
  }
  if (freshness !== null) {
    const classifier = state.nodesById.get(
      freshness.classifier_node_id,
    ) as GraphNode;
    const maxNode = state.nodesById.get(freshness.input_node_id) as GraphNode;
    const fieldNode = state.nodesById.get(maxNode.input as string) as GraphNode;
    if (fieldNode.field_id !== measure.event_time_field_id) {
      fail(
        "invalid_graph",
        "the freshness diagnostic must use the measure event time",
      );
    }
    const expected = checkedAdd(
      contract.lag_millis,
      contract.freshness_slo_millis,
    );
    if (expected === null || classifier.stale_after_millis !== expected) {
      fail(
        "invalid_graph",
        "the classifier threshold must be the checked lag plus SLO",
      );
    }
  }
  void order;
}
