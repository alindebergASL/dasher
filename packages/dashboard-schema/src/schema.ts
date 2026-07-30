import { z } from "zod";

const IsoDateSchema = z.string().datetime({ offset: true });

const SafeSourceUrlSchema = z
  .string()
  .url()
  .refine(
    (value) => {
      const url = new URL(value);
      return (
        (url.protocol === "https:" || url.protocol === "http:") &&
        url.username === "" &&
        url.password === ""
      );
    },
    { message: "Source URL must be credential-free HTTP(S)" },
  );

export const EvidenceSchema = z.strictObject({
  id: z.string().min(1),
  kind: z.enum(["observed", "calculated", "interpreted", "recommended"]),
  label: z.string().min(1),
  sourceName: z.string().min(1),
  sourceUrl: SafeSourceUrlSchema.optional(),
  observedAt: IsoDateSchema.optional(),
  retrievedAt: IsoDateSchema,
  detail: z.string().min(1),
  confidence: z.enum(["high", "medium", "low"]),
});

const ComponentBaseSchema = z.strictObject({
  id: z.string().min(1),
  title: z.string().min(1),
  subtitle: z.string().optional(),
  evidenceIds: z.array(z.string().min(1)).default([]),
});

const SummaryComponentSchema = ComponentBaseSchema.extend({
  kind: z.literal("summary"),
  claims: z
    .array(
      z.strictObject({
        text: z.string().min(1),
        evidenceIds: z.array(z.string().min(1)).min(1),
      }),
    )
    .min(1),
  tone: z.enum(["normal", "attention", "warning"]),
});

const MetricSchema = z.strictObject({
  label: z.string().min(1),
  value: z.string().min(1),
  change: z.string().optional(),
  direction: z.enum(["up", "down", "steady", "unknown"]).optional(),
  evidenceIds: z.array(z.string().min(1)).min(1),
});

const MetricGridComponentSchema = ComponentBaseSchema.extend({
  kind: z.literal("metric-grid"),
  metrics: z.array(MetricSchema).min(1),
});

const GaugeSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  river: z.string().min(1),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  stage: z.number().nullable(),
  stageUnit: z.string().min(1),
  streamflow: z.number().nullable(),
  streamflowUnit: z.string().min(1),
  direction: z.enum(["rising", "falling", "steady", "unknown"]),
  freshness: z.enum(["fresh", "stale", "missing"]),
  evidenceIds: z.array(z.string().min(1)).min(1),
});

const GaugeMapComponentSchema = ComponentBaseSchema.extend({
  kind: z.literal("gauge-map"),
  gauges: z.array(GaugeSchema).min(1),
});

const GaugeTableComponentSchema = ComponentBaseSchema.extend({
  kind: z.literal("gauge-table"),
  gauges: z.array(GaugeSchema).min(1),
});

const RankingComponentSchema = ComponentBaseSchema.extend({
  kind: z.literal("ranking"),
  items: z.array(
    z.strictObject({
      id: z.string().min(1),
      label: z.string().min(1),
      value: z.string().min(1),
      note: z.string().optional(),
      evidenceIds: z.array(z.string().min(1)).min(1),
    }),
  ),
});

const TrendComponentSchema = ComponentBaseSchema.extend({
  kind: z.literal("trend-list"),
  series: z.array(
    z.strictObject({
      id: z.string().min(1),
      label: z.string().min(1),
      unit: z.string().min(1),
      evidenceIds: z.array(z.string().min(1)).min(1),
      points: z
        .array(z.strictObject({ at: IsoDateSchema, value: z.number() }))
        .min(2),
    }),
  ),
});

const AlertComponentSchema = ComponentBaseSchema.extend({
  kind: z.literal("alert-list"),
  alerts: z.array(
    z.strictObject({
      id: z.string().min(1),
      severity: z.enum(["info", "attention", "warning"]),
      title: z.string().min(1),
      detail: z.string().min(1),
      evidenceIds: z.array(z.string().min(1)).min(1),
    }),
  ),
});

const DashboardComponentSchema = z.discriminatedUnion("kind", [
  SummaryComponentSchema,
  MetricGridComponentSchema,
  GaugeMapComponentSchema,
  GaugeTableComponentSchema,
  RankingComponentSchema,
  TrendComponentSchema,
  AlertComponentSchema,
]);

export const PageSchema = z.strictObject({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  components: z.array(DashboardComponentSchema).min(1),
});

export const ArchitectureNodeSchema = z.strictObject({
  id: z.string().min(1),
  label: z.string().min(1),
  detail: z.string().min(1),
  kind: z.enum(["input", "process", "ai", "page", "output"]),
});

export const ArchitectureEdgeSchema = z.strictObject({
  from: z.string().min(1),
  to: z.string().min(1),
  label: z.string().min(1),
});

export const DashboardSpecSchema = z.strictObject({
  schemaVersion: z.literal("1.0"),
  id: z.string().min(1),
  title: z.string().min(1),
  audience: z.string().min(1),
  generatedAt: IsoDateSchema,
  dataMode: z.enum(["demo", "live"]),
  freshness: z.strictObject({
    status: z.enum(["fresh", "stale", "partial"]),
    label: z.string().min(1),
    latestObservationAt: IsoDateSchema.optional(),
  }),
  nextAction: z.strictObject({
    title: z.string().min(1),
    detail: z.string().min(1),
    evidenceIds: z.array(z.string().min(1)).min(1),
  }),
  notice: z.string().min(1),
  pages: z.array(PageSchema).min(1),
  evidence: z.array(EvidenceSchema),
  architecture: z.strictObject({
    title: z.string().min(1),
    summary: z.string().min(1),
    nodes: z.array(ArchitectureNodeSchema).min(2),
    edges: z.array(ArchitectureEdgeSchema).min(1),
  }),
});

export type Evidence = z.infer<typeof EvidenceSchema>;
export type DashboardComponent = z.infer<typeof DashboardComponentSchema>;
export type Page = z.infer<typeof PageSchema>;
export type ArchitectureNode = z.infer<typeof ArchitectureNodeSchema>;
export type ArchitectureEdge = z.infer<typeof ArchitectureEdgeSchema>;
export type DashboardSpec = z.infer<typeof DashboardSpecSchema>;

function assertUnique(ids: string[], label: string): Set<string> {
  const unique = new Set(ids);
  if (unique.size !== ids.length) {
    throw new Error(`${label} must be unique`);
  }
  return unique;
}

export function parseDashboardSpec(input: unknown): DashboardSpec {
  const spec = DashboardSpecSchema.parse(input);
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
      if (component.kind === "gauge-map" || component.kind === "gauge-table") {
        assertUnique(
          component.gauges.map((gauge) => gauge.id),
          `Gauge IDs in component ${component.id}`,
        );
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
      const evidenceLinkedItems: Array<{ evidenceIds: string[] }> =
        component.kind === "metric-grid"
          ? component.metrics
          : component.kind === "gauge-map" || component.kind === "gauge-table"
            ? component.gauges
            : component.kind === "ranking"
              ? component.items
              : component.kind === "trend-list"
                ? component.series
                : component.kind === "alert-list"
                  ? component.alerts
                  : [];
      for (const [index, item] of evidenceLinkedItems.entries()) {
        for (const evidenceId of item.evidenceIds) {
          if (!evidenceIds.has(evidenceId)) {
            throw new Error(
              `Item ${index + 1} in component ${component.id} references missing evidence ${evidenceId}`,
            );
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

  for (const edge of spec.architecture.edges) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
      throw new Error(
        `Architecture edge ${edge.from} -> ${edge.to} references a missing node`,
      );
    }
  }

  return spec;
}
