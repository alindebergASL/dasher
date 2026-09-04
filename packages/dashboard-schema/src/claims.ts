import { canonicalBytes } from "./canonical";
import type { DashboardComponent, DashboardSpec, Evidence } from "./schema";

/**
 * Every assertion a dashboard makes, as a list, addressed by JSON pointer.
 *
 * WHY THIS IS A WALK OVER THE SPEC RATHER THAN OUTPUT FROM A COMPILER. A claim
 * is not something a compiler decides; it is the relationship between a
 * displayed assertion and the evidence already recorded beside it, which the
 * spec fully determines. Derived here, the answer is the same whatever produced
 * the spec and cannot drift between producers.
 *
 * WHY A POINTER RATHER THAN AN ID. `claims.json_pointer` has to survive being
 * read back against bytes, and the only identifier guaranteed to address the
 * same assertion in the stored spec is its position in that document. Component
 * ids are unique but do not locate an item inside a component, and item ids do
 * not exist for metrics or summary claims at all.
 *
 * WHAT IT DELIBERATELY DOES NOT DECIDE. Whether the evidence behind a claim was
 * actually retained. That depends on which `evidence_records` rows exist, which
 * is the caller's knowledge and not the spec's — see `evidenceState` below.
 */

/** The label vocabulary `claims.label` accepts. */
export type ClaimLabel =
  | "observed"
  | "calculated"
  | "hypothesis"
  | "recommendation"
  | "unknown"
  | "blocked";

/** The vocabulary `claims.salience` accepts. */
export type ClaimSalience = "high" | "normal";

export interface SpecClaim {
  /** RFC 6901 pointer to the assertion inside the canonical spec. */
  readonly pointer: string;
  readonly label: ClaimLabel;
  readonly salience: ClaimSalience;
  /** Spec-local evidence ids, in the order the assertion lists them. */
  readonly evidenceIds: readonly string[];
  /**
   * The canonical bytes of the sub-document at `pointer`.
   *
   * Hashed by the caller rather than here, because this package holds no Node
   * types and a SHA-256 needs one. What matters is that the bytes are produced
   * by the same canonicalisation the whole spec is stored under, so a digest
   * taken here and one taken from the stored bytes agree.
   */
  readonly assertionBytes: Uint8Array;
}

/**
 * Ordered strongest to most speculative.
 *
 * A claim inherits the most speculative act that went into it: a figure that is
 * observed everywhere except one interpreted input is an interpretation, and
 * saying otherwise would launder the weakest link. `unknown` is what a claim
 * with no evidence at all gets, and the spec cannot produce one today —
 * `parseDashboardSpec` requires at least one evidence id at every site this
 * walk visits. It exists because the column does, and because a future
 * component kind with optional evidence must land somewhere honest rather than
 * defaulting to `observed`.
 *
 * `blocked` is not reachable from a spec: it describes an assertion the
 * compiler refused to make, which by construction is not in the document.
 */
const LABEL_BY_EVIDENCE_KIND: Record<Evidence["kind"], ClaimLabel> = {
  observed: "observed",
  calculated: "calculated",
  interpreted: "hypothesis",
  recommended: "recommendation",
};

const LABEL_PRECEDENCE: readonly ClaimLabel[] = [
  "recommendation",
  "hypothesis",
  "calculated",
  "observed",
];

/**
 * Build one claim's JSON pointer from the path that addresses it, per RFC 6901.
 *
 * EXPORTED BECAUSE THE POINTER GRAMMAR IS A CONTRACT, not because a test wanted
 * reach. `claims.json_pointer` carries a CHECK that rejects a malformed pointer
 * with a constraint violation, and that violation aborts the whole transaction
 * the snapshot, the evidence, and the version share — so a dashboard would fail
 * to save because of a key somebody added to the schema. This function is where
 * that is prevented, which makes it part of what this module promises.
 *
 * The escaping cannot be reached through a spec today: every token below is a
 * fixed key or a decimal index, and none contains `~` or `/`. That is a
 * property of the current schema rather than of pointers, and the day a
 * component kind arrives whose items are keyed by something a person typed, the
 * unescaped form would silently address the wrong place rather than fail — a
 * wrong pointer is still a well-formed one. Mutation testing reported the
 * escaping as uncovered, which is how it came to be exported and pinned rather
 * than left as decoration.
 */
export function claimPointer(...tokens: readonly (string | number)[]): string {
  return tokens.map((part) => `/${token(part)}`).join("");
}

function token(value: string | number): string {
  return typeof value === "number"
    ? String(value)
    : value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function labelFor(
  evidenceIds: readonly string[],
  byId: ReadonlyMap<string, Evidence>,
): ClaimLabel {
  const present = new Set<ClaimLabel>();
  for (const id of evidenceIds) {
    const evidence = byId.get(id);
    // An unresolved id cannot occur — `parseDashboardSpec` rejects one at every
    // site — but a missing entry must not silently read as `observed`.
    if (evidence === undefined) return "unknown";
    present.add(LABEL_BY_EVIDENCE_KIND[evidence.kind]);
  }
  return LABEL_PRECEDENCE.find((label) => present.has(label)) ?? "unknown";
}

/**
 * The item arrays that carry assertions, by component kind.
 *
 * The component's own `evidenceIds` is not among them on purpose: a component
 * is a container, and recording it as a claim of its own would count the same
 * assertion twice — once as "the metric grid says something" and once for each
 * metric that actually says it.
 *
 * WHAT THIS COSTS, stated because it is not nothing. Nothing makes a
 * component's `evidenceIds` the union of its items': the schema defaults it to
 * `[]` and only checks each id resolves, so a compiler may cite calculation
 * evidence at the container that no individual item names. Such a citation
 * appears in the evidence panel and in no claim. A component kind whose
 * container evidence is genuinely its own would need a claim of its own.
 */
function assertionItems(
  component: DashboardComponent,
): readonly [string, readonly { readonly evidenceIds: string[] }[]] {
  switch (component.kind) {
    case "summary":
      return ["claims", component.claims];
    case "metric-grid":
      return ["metrics", component.metrics];
    case "table":
      return ["rows", component.rows];
    case "ranking":
      return ["items", component.items];
    case "trend-list":
      return ["series", component.series];
    case "alert-list":
      return ["alerts", component.alerts];
  }
}

/**
 * Read the sub-document a pointer addresses, from the spec it was built from.
 *
 * Walking the object rather than re-deriving the value keeps the digest honest:
 * whatever is at the pointer is what gets hashed, so a claim cannot record a
 * digest of something the pointer does not actually address.
 */
function at(spec: DashboardSpec, path: readonly (string | number)[]): unknown {
  let current: unknown = spec;
  for (const step of path) {
    current = (current as Record<string | number, unknown>)[step];
  }
  return current;
}

export function extractSpecClaims(spec: DashboardSpec): readonly SpecClaim[] {
  const byId = new Map(spec.evidence.map((item) => [item.id, item]));
  const claims: SpecClaim[] = [];

  const add = (
    path: readonly (string | number)[],
    evidenceIds: readonly string[],
    salience: ClaimSalience,
  ): void => {
    claims.push({
      pointer: claimPointer(...path),
      label: labelFor(evidenceIds, byId),
      salience,
      evidenceIds,
      assertionBytes: canonicalBytes(at(spec, path)),
    });
  };

  // High salience is the schema's own structure rather than a judgement: the
  // next action and the three executive-brief slots are the assertions the
  // dashboard puts in front of a reader before anything else, and are the ones
  // a reviewer would want to trace first.
  add(["nextAction"], spec.nextAction.evidenceIds, "high");
  for (const slot of ["known", "changed", "important"] as const) {
    add(
      ["executiveBrief", slot],
      spec.executiveBrief[slot].evidenceIds,
      "high",
    );
  }

  for (const [pageIndex, page] of spec.pages.entries()) {
    for (const [componentIndex, component] of page.components.entries()) {
      const [key, items] = assertionItems(component);
      for (const [itemIndex, item] of items.entries()) {
        add(
          ["pages", pageIndex, "components", componentIndex, key, itemIndex],
          item.evidenceIds,
          "normal",
        );
      }
    }
  }

  return claims;
}
