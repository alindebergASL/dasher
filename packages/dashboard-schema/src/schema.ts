import { z } from "zod";

export const DASHBOARD_SPEC_MAX_BYTES = 1_048_576;
export const DASHBOARD_MAX_TOTAL_ITEMS = 2_000;
export const DASHBOARD_MAX_TOTAL_TREND_POINTS = 10_000;
export const DASHBOARD_MAX_TOTAL_EVIDENCE_REFERENCES = 10_000;
export const DASHBOARD_MAX_EVIDENCE_IDS = 32;

export const DASHBOARD_STRING_LIMITS = {
  id: 128,
  shortText: 256,
  longText: 4_096,
  url: 2_048,
  isoTimestamp: 64,
} as const;

const IdentifierSchema = z.string().min(1).max(DASHBOARD_STRING_LIMITS.id);
const ShortTextSchema = z
  .string()
  .min(1)
  .max(DASHBOARD_STRING_LIMITS.shortText);
const OptionalShortTextSchema = z
  .string()
  .max(DASHBOARD_STRING_LIMITS.shortText)
  .optional();
const LongTextSchema = z.string().min(1).max(DASHBOARD_STRING_LIMITS.longText);
const OptionalLongTextSchema = z
  .string()
  .max(DASHBOARD_STRING_LIMITS.longText)
  .optional();
const IsoDateSchema = z
  .string()
  .max(DASHBOARD_STRING_LIMITS.isoTimestamp)
  .datetime({ offset: true });
const EvidenceIdsSchema = z
  .array(IdentifierSchema)
  .max(DASHBOARD_MAX_EVIDENCE_IDS);
const RequiredEvidenceIdsSchema = EvidenceIdsSchema.min(1);

const SafeSourceUrlSchema = z
  .string()
  .max(DASHBOARD_STRING_LIMITS.url)
  .url()
  .refine(
    (value) => {
      try {
        const url = new URL(value);
        return (
          (url.protocol === "https:" || url.protocol === "http:") &&
          url.username === "" &&
          url.password === ""
        );
      } catch {
        return false;
      }
    },
    { message: "Source URL must be credential-free HTTP(S)" },
  );

export const EvidenceSchema = z
  .strictObject({
    id: IdentifierSchema,
    kind: z.enum(["observed", "calculated", "interpreted", "recommended"]),
    label: ShortTextSchema,
    sourceName: ShortTextSchema,
    sourceUrl: SafeSourceUrlSchema.optional(),
    observedAt: IsoDateSchema.optional(),
    retrievedAt: IsoDateSchema,
    detail: LongTextSchema,
    confidence: z.enum(["high", "medium", "low"]),
  })
  .superRefine((evidence, context) => {
    if (
      evidence.observedAt !== undefined &&
      Date.parse(evidence.observedAt) > Date.parse(evidence.retrievedAt)
    ) {
      context.addIssue({
        code: "custom",
        message: "Evidence observedAt must not be after retrievedAt",
        path: ["observedAt"],
      });
    }
  });

const ComponentBaseSchema = z.strictObject({
  id: IdentifierSchema,
  title: ShortTextSchema,
  subtitle: OptionalLongTextSchema,
  evidenceIds: EvidenceIdsSchema.default([]),
});

const SummaryComponentSchema = ComponentBaseSchema.extend({
  kind: z.literal("summary"),
  claims: z
    .array(
      z.strictObject({
        text: LongTextSchema,
        evidenceIds: RequiredEvidenceIdsSchema,
      }),
    )
    .min(1)
    .max(24),
  tone: z.enum(["normal", "attention", "warning"]),
});

const MetricSchema = z.strictObject({
  label: ShortTextSchema,
  value: ShortTextSchema,
  change: OptionalShortTextSchema,
  direction: z.enum(["up", "down", "steady", "unknown"]).optional(),
  evidenceIds: RequiredEvidenceIdsSchema,
});

const MetricGridComponentSchema = ComponentBaseSchema.extend({
  kind: z.literal("metric-grid"),
  metrics: z.array(MetricSchema).min(1).max(24),
});

/**
 * Cells are display strings rather than typed values: the contract has no
 * domain, so the compiler formats numbers, units, and dates before they land
 * here. Every row cites the evidence its cells rest on.
 */
const TableComponentSchema = ComponentBaseSchema.extend({
  kind: z.literal("table"),
  columns: z.array(ShortTextSchema).min(1).max(12),
  rows: z
    .array(
      z.strictObject({
        id: IdentifierSchema,
        cells: z.array(z.string().max(DASHBOARD_STRING_LIMITS.shortText)),
        evidenceIds: RequiredEvidenceIdsSchema,
      }),
    )
    .max(100),
});

const RankingComponentSchema = ComponentBaseSchema.extend({
  kind: z.literal("ranking"),
  items: z
    .array(
      z.strictObject({
        id: IdentifierSchema,
        label: ShortTextSchema,
        value: ShortTextSchema,
        note: OptionalLongTextSchema,
        evidenceIds: RequiredEvidenceIdsSchema,
      }),
    )
    .max(100),
});

const TrendComponentSchema = ComponentBaseSchema.extend({
  kind: z.literal("trend-list"),
  series: z
    .array(
      z.strictObject({
        id: IdentifierSchema,
        label: ShortTextSchema,
        unit: ShortTextSchema,
        evidenceIds: RequiredEvidenceIdsSchema,
        points: z
          .array(z.strictObject({ at: IsoDateSchema, value: z.number() }))
          .min(2)
          .max(5_000),
      }),
    )
    .max(100),
});

const AlertComponentSchema = ComponentBaseSchema.extend({
  kind: z.literal("alert-list"),
  alerts: z
    .array(
      z.strictObject({
        id: IdentifierSchema,
        severity: z.enum(["info", "attention", "warning"]),
        title: ShortTextSchema,
        detail: LongTextSchema,
        evidenceIds: RequiredEvidenceIdsSchema,
      }),
    )
    .max(200),
});

const DashboardComponentSchema = z.discriminatedUnion("kind", [
  SummaryComponentSchema,
  MetricGridComponentSchema,
  TableComponentSchema,
  RankingComponentSchema,
  TrendComponentSchema,
  AlertComponentSchema,
]);

export const PageSchema = z.strictObject({
  id: IdentifierSchema,
  title: ShortTextSchema,
  description: LongTextSchema,
  components: z.array(DashboardComponentSchema).min(1).max(24),
});

export const ArchitectureNodeSchema = z.strictObject({
  id: IdentifierSchema,
  label: ShortTextSchema,
  detail: LongTextSchema,
  kind: z.enum(["input", "process", "ai", "page", "output"]),
});

export const ArchitectureEdgeSchema = z.strictObject({
  from: IdentifierSchema,
  to: IdentifierSchema,
  label: ShortTextSchema,
});

const ExecutiveStatementTypeSchema = z.enum([
  "observed",
  "calculated",
  "interpreted",
]);

const ExecutiveBriefClaimSchema = z.strictObject({
  statementTypes: z
    .array(ExecutiveStatementTypeSchema)
    .min(1)
    .max(2)
    .refine((values) => new Set(values).size === values.length, {
      message: "Executive statement types must be unique",
    }),
  headline: ShortTextSchema,
  detail: LongTextSchema,
  evidenceIds: RequiredEvidenceIdsSchema,
});

const ExecutiveBriefSchema = z.strictObject({
  known: ExecutiveBriefClaimSchema,
  changed: ExecutiveBriefClaimSchema,
  important: ExecutiveBriefClaimSchema,
});

const DashboardSpecShape = {
  id: IdentifierSchema,
  title: ShortTextSchema,
  audience: ShortTextSchema,
  generatedAt: IsoDateSchema,
  dataMode: z.enum(["demo", "live"]),
  freshness: z.strictObject({
    status: z.enum(["fresh", "stale", "partial"]),
    label: ShortTextSchema,
    latestObservationAt: IsoDateSchema.optional(),
  }),
  nextAction: z.strictObject({
    title: ShortTextSchema,
    detail: LongTextSchema,
    evidenceIds: RequiredEvidenceIdsSchema,
  }),
  notice: LongTextSchema,
  pages: z.array(PageSchema).min(1).max(16),
  evidence: z.array(EvidenceSchema).max(500),
  architecture: z.strictObject({
    title: ShortTextSchema,
    summary: LongTextSchema,
    nodes: z.array(ArchitectureNodeSchema).min(2).max(64),
    edges: z.array(ArchitectureEdgeSchema).min(1).max(256),
  }),
};

export const DashboardSpecSchema = z
  .discriminatedUnion("schemaVersion", [
    // One accepted version, on purpose. 1.0 and 1.1 were dropped by ADR-007
    // while zero dashboards were persisted outside tests; sealed bytes in an
    // old version take /d/[id]'s documented 404 path rather than a forever
    // branch in every consumer.
    z.strictObject({
      schemaVersion: z.literal("1.2"),
      ...DashboardSpecShape,
      executiveBrief: ExecutiveBriefSchema,
    }),
  ])
  .superRefine((spec, context) => {
    const generatedAt = Date.parse(spec.generatedAt);

    if (
      spec.freshness.status === "fresh" &&
      spec.freshness.latestObservationAt === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "Fresh status requires latestObservationAt",
        path: ["freshness", "latestObservationAt"],
      });
    }

    if (
      spec.freshness.latestObservationAt !== undefined &&
      Date.parse(spec.freshness.latestObservationAt) > generatedAt
    ) {
      context.addIssue({
        code: "custom",
        message: "Freshness latestObservationAt must not be after generatedAt",
        path: ["freshness", "latestObservationAt"],
      });
    }

    for (const [index, evidence] of spec.evidence.entries()) {
      if (Date.parse(evidence.retrievedAt) > generatedAt) {
        context.addIssue({
          code: "custom",
          message: "Evidence retrievedAt must not be after generatedAt",
          path: ["evidence", index, "retrievedAt"],
        });
      }
    }
  });

export type Evidence = z.infer<typeof EvidenceSchema>;
export type DashboardComponent = z.infer<typeof DashboardComponentSchema>;
export type Page = z.infer<typeof PageSchema>;
export type ArchitectureNode = z.infer<typeof ArchitectureNodeSchema>;
export type ArchitectureEdge = z.infer<typeof ArchitectureEdgeSchema>;
export type DashboardSpec = z.infer<typeof DashboardSpecSchema>;

/** The per-kind item array whose entries each cite their own evidence. */
function evidenceLinkedItems(
  component: DashboardComponent,
): readonly { readonly evidenceIds: string[] }[] {
  switch (component.kind) {
    case "summary":
      return component.claims;
    case "metric-grid":
      return component.metrics;
    case "table":
      return component.rows;
    case "ranking":
      return component.items;
    case "trend-list":
      return component.series;
    case "alert-list":
      return component.alerts;
  }
}

function assertUnique(ids: string[], label: string): Set<string> {
  const unique = new Set(ids);
  if (unique.size !== ids.length) {
    throw new Error(`${label} must be unique`);
  }
  return unique;
}

function assertAtMost(value: number, maximum: number, label: string): void {
  if (value > maximum) {
    throw new Error(`${label} exceeds the maximum of ${maximum}`);
  }
}

function createDashboardSpecSnapshot(input: unknown): unknown {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(input);
  } catch {
    throw new Error("DashboardSpec input must be JSON-serializable");
  }

  if (serialized === undefined) {
    throw new Error("DashboardSpec input must be JSON-serializable");
  }

  const byteLength = new TextEncoder().encode(serialized).byteLength;
  if (byteLength > DASHBOARD_SPEC_MAX_BYTES) {
    throw new Error(
      `DashboardSpec input exceeds the ${DASHBOARD_SPEC_MAX_BYTES}-byte serialized limit`,
    );
  }

  return JSON.parse(serialized) as unknown;
}

function assertDashboardComplexityBudgets(spec: DashboardSpec): void {
  let totalItems =
    spec.pages.length +
    spec.evidence.length +
    spec.architecture.nodes.length +
    spec.architecture.edges.length;
  let totalTrendPoints = 0;
  let totalEvidenceReferences =
    spec.nextAction.evidenceIds.length +
    spec.executiveBrief.known.evidenceIds.length +
    spec.executiveBrief.changed.evidenceIds.length +
    spec.executiveBrief.important.evidenceIds.length;

  for (const page of spec.pages) {
    totalItems += page.components.length;
    for (const component of page.components) {
      totalEvidenceReferences += component.evidenceIds.length;

      const items = evidenceLinkedItems(component);
      totalItems += items.length;
      totalEvidenceReferences += items.reduce(
        (total, item) => total + item.evidenceIds.length,
        0,
      );

      if (component.kind === "trend-list") {
        totalTrendPoints += component.series.reduce(
          (total, series) => total + series.points.length,
          0,
        );
      }
    }
  }

  assertAtMost(
    totalItems,
    DASHBOARD_MAX_TOTAL_ITEMS,
    "DashboardSpec total item count",
  );
  assertAtMost(
    totalTrendPoints,
    DASHBOARD_MAX_TOTAL_TREND_POINTS,
    "DashboardSpec total trend point count",
  );
  assertAtMost(
    totalEvidenceReferences,
    DASHBOARD_MAX_TOTAL_EVIDENCE_REFERENCES,
    "DashboardSpec total evidence reference count",
  );
}

export function parseDashboardSpec(input: unknown): DashboardSpec {
  const snapshot = createDashboardSpecSnapshot(input);
  const spec = DashboardSpecSchema.parse(snapshot);
  assertDashboardComplexityBudgets(spec);

  assertUnique(
    spec.pages.map((page) => page.id),
    "Page IDs",
  );
  const evidenceIds = assertUnique(
    spec.evidence.map((item) => item.id),
    "Evidence IDs",
  );
  const nodeIds = assertUnique(
    spec.architecture.nodes.map((node) => node.id),
    "Architecture node IDs",
  );
  const componentIds: string[] = [];

  for (const page of spec.pages) {
    for (const component of page.components) {
      componentIds.push(component.id);
      if (component.kind === "table") {
        assertUnique(
          component.rows.map((row) => row.id),
          `Row IDs in component ${component.id}`,
        );
        for (const row of component.rows) {
          if (row.cells.length !== component.columns.length) {
            throw new Error(
              `Row ${row.id} in component ${component.id} has ${row.cells.length} cells for ${component.columns.length} columns`,
            );
          }
        }
      } else if (component.kind === "ranking") {
        assertUnique(
          component.items.map((item) => item.id),
          `Ranking item IDs in component ${component.id}`,
        );
      } else if (component.kind === "trend-list") {
        assertUnique(
          component.series.map((series) => series.id),
          `Trend series IDs in component ${component.id}`,
        );
      } else if (component.kind === "alert-list") {
        assertUnique(
          component.alerts.map((alert) => alert.id),
          `Alert IDs in component ${component.id}`,
        );
      }
      if (component.kind === "summary") {
        assertUnique(
          component.claims.map((claim) => claim.text),
          `Claim texts in component ${component.id}`,
        );
        for (const claim of component.claims) {
          for (const evidenceId of claim.evidenceIds) {
            if (!evidenceIds.has(evidenceId)) {
              throw new Error(
                `Summary claim in ${component.id} references missing evidence ${evidenceId}`,
              );
            }
          }
        }
      }
      if (component.kind === "metric-grid") {
        assertUnique(
          component.metrics.map((metric) => metric.label),
          `Metric labels in component ${component.id}`,
        );
      }
      if (component.kind !== "summary") {
        for (const [index, item] of evidenceLinkedItems(component).entries()) {
          for (const evidenceId of item.evidenceIds) {
            if (!evidenceIds.has(evidenceId)) {
              throw new Error(
                `Item ${index + 1} in component ${component.id} references missing evidence ${evidenceId}`,
              );
            }
          }
        }
      }
      for (const evidenceId of component.evidenceIds) {
        if (!evidenceIds.has(evidenceId)) {
          throw new Error(
            `Component ${component.id} references missing evidence ${evidenceId}`,
          );
        }
      }
    }
  }
  assertUnique(componentIds, "Component IDs");

  for (const evidenceId of spec.nextAction.evidenceIds) {
    if (!evidenceIds.has(evidenceId)) {
      throw new Error(`Next action references missing evidence ${evidenceId}`);
    }
  }

  for (const [label, claim] of [
    ["Known", spec.executiveBrief.known],
    ["Changed", spec.executiveBrief.changed],
    ["Important", spec.executiveBrief.important],
  ] as const) {
    if (claim.evidenceIds.some((evidenceId) => !evidenceIds.has(evidenceId))) {
      throw new Error(`Executive brief ${label} references missing evidence`);
    }
  }

  assertUnique(
    spec.architecture.edges.map((edge) =>
      JSON.stringify([edge.from, edge.to, edge.label]),
    ),
    "Architecture edges",
  );
  for (const edge of spec.architecture.edges) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
      throw new Error(
        `Architecture edge ${edge.from} -> ${edge.to} references a missing node`,
      );
    }
  }

  return spec;
}
