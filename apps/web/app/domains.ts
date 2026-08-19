import { AIR_COMPUTATION, AIR_WORDS } from "@dasher/air-domain";
import {
  FakePlanningProvider,
  RIVER_FAKE_PHRASING,
  type FakePlannerPhrasing,
  type PlanningProvider,
} from "@dasher/planner";
import { RIVER_COMPUTATION, RIVER_WORDS } from "@dasher/river-domain";
import type {
  StationComputation,
  StationWords,
  ThresholdRule,
} from "@dasher/station-domain";

/**
 * The domain catalog and the deterministic request router.
 *
 * Two entries, on purpose. This is a catalog, not a plugin framework: adding a
 * third domain means adding a third literal entry, and the day that becomes
 * painful is the day a framework has earned its complexity. Everything a
 * domain needs to INTERPRET a request lives on its entry — computation
 * policy, vocabulary, demo thresholds, and a planner phrased in the domain's
 * words — so nothing downstream ever mixes one domain's readings with
 * another's rules. The observations themselves do not live here: those come
 * from `source-runtime.ts` at request time, because where readings come from
 * is a deployment question and what they mean is a domain one.
 *
 * ROUTING IS DETERMINISTIC AND FAILS CLOSED. A request either names a domain
 * this product supports, names both, or names neither — and the router says
 * which, rather than guessing. There is deliberately NO fallback to the
 * river: the product's first fixture is not its default answer, and "UC
 * Riverside enrollment" producing a Sacramento river dashboard would be the
 * exact kind of confident wrongness Dasher exists to refuse. Word boundaries
 * carry that case: /\briver\b/ matches "river" and "rivers" but not
 * "Riverside".
 */

export interface DomainEntry {
  readonly key: DomainKey;
  /** How a refusal names this domain to a reader: "river", "air-quality". */
  readonly label: string;
  readonly computation: StationComputation;
  readonly words: StationWords;
  readonly thresholds: readonly ThresholdRule[];
  readonly provider: PlanningProvider;
}

export type DomainKey = "river" | "air";

export type DomainDecision =
  | { kind: "domain"; domain: DomainEntry }
  | { kind: "ambiguous" }
  | { kind: "unsupported" };

/** Air phrasing for the fake planner's five compositions. */
const AIR_FAKE_PHRASING: FakePlannerPhrasing = {
  emergency: {
    title: "Sacramento Air Quality Watch",
    audience: "Emergency management leads",
    framing:
      "Conditions ordered for incident response: what needs attention first, then where it is, then how fast it is worsening.",
    pages: [
      { title: "Watch", description: "Active concerns and where they are." },
      {
        title: "Movement",
        description: "How fast readings are changing and over which windows.",
      },
    ],
  },
  movement: {
    title: "Sacramento Air Quality Movement",
    audience: "Operations managers",
    framing:
      "Ordered by rate of change: the fastest movers first, then the windows behind those numbers.",
    pages: [
      {
        title: "What is moving",
        description: "Monitors ranked by recent PM2.5 change.",
      },
      {
        title: "Context",
        description: "Where the moving monitors are and what needs a look.",
      },
    ],
  },
  resident: {
    title: "Air Quality Near You",
    audience: "Homeowners and residents",
    framing:
      "A short read: whether anything needs attention right now, and the current reading at each nearby monitor.",
    pages: [
      {
        title: "Right now",
        description: "Current conditions in plain language.",
      },
    ],
  },
  map: {
    title: "Sacramento Monitor Map",
    audience: "Managers and community leaders",
    framing: "Location first, with current readings beside each monitor.",
    pages: [
      {
        title: "Map",
        description: "Monitor locations and their current state.",
      },
    ],
  },
  overview: {
    title: "Sacramento Air Quality",
    audience: "Managers and community leaders",
    framing:
      "What is happening now, what changed, and what deserves attention.",
    pages: [
      {
        title: "Overview",
        description: "What is happening now and what deserves attention.",
      },
      {
        title: "Monitor details",
        description: "Current readings, changes, and recent PM2.5 history.",
      },
    ],
  },
};

const RIVER_ENTRY: DomainEntry = {
  key: "river",
  label: "river",
  computation: RIVER_COMPUTATION,
  words: RIVER_WORDS,
  thresholds: [
    {
      id: "freeport-demo-threshold",
      siteId: "11447650",
      label: "Freeport watch level",
      above: 14.5,
    },
  ],
  provider: new FakePlanningProvider(RIVER_FAKE_PHRASING),
};

const AIR_ENTRY: DomainEntry = {
  key: "air",
  label: "air-quality",
  computation: AIR_COMPUTATION,
  words: AIR_WORDS,
  thresholds: [
    {
      id: "elevated-pm25-demo-threshold",
      siteId: "678",
      label: "Elevated PM2.5 watch",
      above: 15,
    },
  ],
  provider: new FakePlanningProvider(AIR_FAKE_PHRASING),
};

export const DOMAIN_CATALOG: Readonly<Record<DomainKey, DomainEntry>> = {
  river: RIVER_ENTRY,
  air: AIR_ENTRY,
};

/**
 * Words that recognisably ask for each domain. Word-boundary regexes, not
 * substrings: "Riverside" must not read as "river", and "fairground" must not
 * read as "air". Kept deliberately small — a word earns its place here by
 * being what people actually type, and a near-miss is an "unsupported" answer
 * with an explanation, which is recoverable in one retype.
 */
const RIVER_SIGNALS =
  /\b(?:rivers?|gauges?|floods?|flooding|streamflow|creeks?|water\s+levels?|water-levels?)\b/iu;
const AIR_SIGNALS =
  /\b(?:air\s+quality|air-quality|\bair\b|aqi|pm\s*2\.?5|pm25|ozone|smoke|particulates?|wildfire)\b/iu;

export function classifyRequest(requestText: string): DomainDecision {
  const river = RIVER_SIGNALS.test(requestText);
  const air = AIR_SIGNALS.test(requestText);

  if (river && air) return { kind: "ambiguous" };
  if (river) return { kind: "domain", domain: DOMAIN_CATALOG.river };
  if (air) return { kind: "domain", domain: DOMAIN_CATALOG.air };
  return { kind: "unsupported" };
}
