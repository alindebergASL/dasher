/**
 * The generic half of a sensor domain: what every monitored network shares.
 *
 * ADR-007 made the dashboard contract describe stations; this package is the
 * matching computation layer. It knows that a station has a location, up to
 * two reading series, freshness, and trends — and it deliberately does not
 * know what any of it is called. The words (a river gauge's "Water-level", an
 * air monitor's "AQI") arrive in the data, put there by the domain package
 * whose parser built the station.
 */

export interface Observation {
  at: string;
  value: number;
}

export interface Series {
  unit: string;
  observations: Observation[];
}

export interface Station {
  siteId: string;
  name: string;
  /** The domain's grouping for this station: a river, an air basin. */
  group: string;
  /** The domain's noun for one station, lowercase: "gauge", "monitor". */
  kindLabel: string;
  latitude: number;
  longitude: number;
  /**
   * What the two readings are called, heading-cased: "Water-level", "AQI".
   * On the station rather than the series, because a station whose sensor is
   * down still needs the right words for what is missing.
   */
  primaryLabel: string;
  secondaryLabel: string;
  primary?: Series;
  secondary?: Series;
  /** Where the readings came from, for the evidence record. */
  sourceName: string;
  sourceUrl: string;
  /** Evidence-id namespace: `${evidencePrefix}-${siteId}`. */
  evidencePrefix: string;
  retrievedAt: string;
}
