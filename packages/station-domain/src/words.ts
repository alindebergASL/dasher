/**
 * The words a domain uses when a dashboard talks about its stations.
 *
 * `StationComputation` carries a domain's numbers; this carries its nouns.
 * The compiler composes sentences — counts, verbs, agreement — and fills
 * every domain-specific slot from here, so the same sentence template reads
 * "3 gauges are rising" for the river and "3 monitors are rising" for air.
 * If the compiler ever needs a word this interface does not have, the word
 * belongs here, not inline: an inline word is the river's by default, which
 * is exactly the defect this type exists to end.
 */
export interface StationWords {
  /** Kebab-case identifier material: "river" → id "planned-river-conditions". */
  slug: string;
  /** Lowercase noun for one station: "gauge", "monitor". */
  noun: string;
  /** Its plural: "gauges", "monitors". */
  nounPlural: string;
  /**
   * The primary reading as it appears mid-sentence: "water-level", "PM2.5".
   * Used in phrases like "one-hour water-level rise" and "fresh water-level
   * readings", so it must read as a modifier, not a heading.
   */
  reading: string;
  /** Column headings for the station table; heading-cased. */
  columns: { station: string; primary: string; secondary: string };
  /** The provisional-data notice, a full sentence or two; domain-legal. */
  notice: string;
  /** How the architecture panel names the data source. */
  source: {
    /** Node label: "River gauge readings". */
    label: string;
    /** Node detail: what arrives from the source, as a sentence. */
    detail: string;
    /** Adjective for the wire format: "USGS-format", "OpenAQ-format". */
    format: string;
  };
}

/** "gauges" → "Gauges", for headings built from a domain noun. */
export function headingCase(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}
