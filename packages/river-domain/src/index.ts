export {
  buildGaugeMetrics,
  type GaugeMetrics,
  type TrendDirection,
} from "./metrics";
export {
  parseUsgsInstantaneousValues,
  USGS_MAX_TOTAL_OBSERVATIONS,
  USGS_PAYLOAD_MAX_BYTES,
  USGS_STRING_LIMITS,
  type GaugeSeries,
  type Observation,
  type RiverGauge,
} from "./usgs";
export {
  createRiverDashboard,
  type RiverDashboardOptions,
  type ThresholdRule,
} from "./dashboard";
