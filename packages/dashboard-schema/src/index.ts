export {
  ArchitectureEdgeSchema,
  ArchitectureNodeSchema,
  DASHBOARD_MAX_EVIDENCE_IDS,
  DASHBOARD_MAX_TOTAL_EVIDENCE_REFERENCES,
  DASHBOARD_MAX_TOTAL_ITEMS,
  DASHBOARD_MAX_TOTAL_TREND_POINTS,
  DASHBOARD_SPEC_MAX_BYTES,
  DASHBOARD_STRING_LIMITS,
  DashboardSpecSchema,
  EvidenceSchema,
  PageSchema,
  parseDashboardSpec,
  type ArchitectureEdge,
  type ArchitectureNode,
  type DashboardComponent,
  type DashboardSpec,
  type Evidence,
  type Page,
} from "./schema";

export {
  COMPONENT_LAYOUT,
  LAYOUT_COLUMNS,
  packComponents,
  type DashboardComponentKind,
  type LayoutConstraint,
  type PlacedComponent,
} from "./layout";

export { canonicalSpecBytes } from "./canonical";
export {
  composeDashboards,
  DashboardCompositionError,
  MAX_COMPOSED_SOURCES,
  isPresent,
  type AbsentSource,
  type ComposedSource,
  type ComposedSources,
  type ComposeOptions,
  type CompositionMember,
} from "./compose";
