import "server-only";

import { parseOpenAqHourlySnapshot } from "@dasher/air-domain";
import { parseUsgsInstantaneousValues } from "@dasher/river-domain";
import type { Station } from "@dasher/station-domain";

import airFixture from "../../../fixtures/openaq/sacramento-hourly.json";
import riverFixture from "../../../fixtures/usgs/sacramento-instantaneous-values.json";
import type { DomainKey } from "./domains";

/**
 * The one place in Dasher that talks to a network.
 *
 * WHY IT IS HERE AND NOT IN A DOMAIN PACKAGE. `@dasher/river-domain` and
 * `@dasher/air-domain` are parsers: they take bytes and produce `Station[]`
 * or throw. That purity is what makes them testable without a socket and
 * reusable outside a web request, and it is worth protecting. Timeouts,
 * size limits, caching, coalescing, and credentials are properties of a
 * deployment, not of a data format, so they live here — server-only, in the
 * app, behind one function.
 *
 * WHY THERE IS NO CONNECTOR FRAMEWORK. Two sources, two literal branches.
 * A registry of adapters would be the same code with indirection on top,
 * and the day a third source makes this painful is the day the abstraction
 * has evidence behind it.
 *
 * FAIL CLOSED, NEVER QUIETLY. In live mode a source failure refuses the
 * request. It does not fall back to the fixture: a dashboard built from
 * yesterday's committed sample, presented as what is happening now, is the
 * exact dishonesty every gate in this product exists to prevent. The
 * refusal is a `SourceUnavailableError`, and the caller persists nothing.
 *
 * STALE IS NOT THE SAME AS BROKEN. A payload that arrives and parses builds
 * a dashboard even if its observations are hours old — the freshness
 * machinery marks that visibly, which is a truthful answer. Only failure to
 * obtain a valid payload refuses.
 */

/** How long a successfully parsed snapshot may be reused. */
const CACHE_TTL_MS = 5 * 60 * 1000;
/** How long one upstream attempt may take before it is abandoned. */
const FETCH_TIMEOUT_MS = 10_000;
/** Refused past this many bytes, read incrementally rather than trusted. */
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

const USGS_SITE_IDS = ["11446500", "11447650", "11446220"] as const;
const USGS_PARAMETER_CODES = ["00065", "00060"] as const;
/**
 * Fixed Sacramento-area OpenAQ locations and their sensors, VERIFIED LIVE.
 *
 * The first version of this list was assembled from the fixture and was
 * wrong in every entry: 2178 is Del Norte, 2183 is Denver, 2190 is an
 * Osceola County fire station, and their sensor ids did not match the
 * PM2.5/ozone pairs this domain reads. A live check against the real API
 * replaced them with these.
 */
const OPENAQ_LOCATIONS = [
  { id: 678, pm25: 1556, ozone: 1548 },
  { id: 1289, pm25: 2309, ozone: 2305 },
  { id: 627, pm25: 1100, ozone: 1101 },
] as const;

export interface DomainSnapshot {
  readonly stations: readonly Station[];
  /** When this snapshot was obtained: the source's own retrieval time. */
  readonly asOf: string;
}

export type SourceMode = "fixture" | "live";

/**
 * A source failure a reader may be told about.
 *
 * The message is deliberately incurious about the cause. An upstream 401, a
 * timeout, and a malformed body are one fact to the person who typed a
 * request — their dashboard cannot be built right now — and the difference
 * between them must not become a channel that describes Dasher's
 * credentials or upstream topology to whoever asks.
 */
export class SourceUnavailableError extends Error {
  readonly domain: DomainKey;

  constructor(domain: DomainKey, cause?: unknown) {
    super(`live source unavailable for ${domain}`);
    this.name = "SourceUnavailableError";
    this.domain = domain;
    if (cause !== undefined) this.cause = cause;
  }
}

export function sourceMode(): SourceMode {
  return process.env["DASHER_SOURCE_MODE"] === "live" ? "live" : "fixture";
}

interface CacheEntry {
  snapshot: DomainSnapshot;
  expiresAt: number;
}

// Process-local, deliberately. One node's worth of cache is what this slice
// needs to stop every page view becoming an upstream request; a shared cache
// is a different problem with different failure modes.
const cache = new Map<DomainKey, CacheEntry>();
const inFlight = new Map<DomainKey, Promise<DomainSnapshot>>();

/** Test seam: the fixture-mode snapshots, parsed once. */
const FIXTURE_SNAPSHOTS: Record<DomainKey, () => DomainSnapshot> = {
  river: () => ({
    stations: parseUsgsInstantaneousValues(riverFixture),
    asOf: "2026-07-29T12:02:00.000Z",
  }),
  air: () => ({
    stations: parseOpenAqHourlySnapshot(airFixture),
    asOf: "2026-08-18T12:02:00.000Z",
  }),
};

export function clearSourceCache(): void {
  cache.clear();
  inFlight.clear();
}

export async function loadDomainSnapshot(
  domain: DomainKey,
): Promise<DomainSnapshot> {
  if (sourceMode() === "fixture") {
    // Deterministic and offline: CI and local development never depend on an
    // upstream being reachable or on what it happens to be reporting today.
    return FIXTURE_SNAPSHOTS[domain]();
  }

  const cached = cache.get(domain);
  if (cached !== undefined && cached.expiresAt > Date.now()) {
    return cached.snapshot;
  }

  // Coalesce: ten concurrent readers asking for river conditions are one
  // upstream request, not ten. Without this the cache only helps requests
  // that arrive after the first one has finished.
  const existing = inFlight.get(domain);
  if (existing !== undefined) return existing;

  const attempt = fetchSnapshot(domain)
    .then((snapshot) => {
      // Only successes are cached. Caching a failure would turn one bad
      // minute upstream into five bad minutes here.
      cache.set(domain, { snapshot, expiresAt: Date.now() + CACHE_TTL_MS });
      return snapshot;
    })
    .finally(() => {
      inFlight.delete(domain);
    });

  inFlight.set(domain, attempt);
  return attempt;
}

async function fetchSnapshot(domain: DomainKey): Promise<DomainSnapshot> {
  try {
    return domain === "river"
      ? await fetchRiverSnapshot()
      : await fetchAirSnapshot();
  } catch (error) {
    // One error type out, whatever happened in. The cause is attached for a
    // server-side reader and never rendered.
    if (error instanceof SourceUnavailableError) throw error;
    throw new SourceUnavailableError(domain, error);
  }
}

async function fetchRiverSnapshot(): Promise<DomainSnapshot> {
  const url = new URL("https://waterservices.usgs.gov/nwis/iv/");
  url.searchParams.set("format", "json");
  url.searchParams.set("sites", USGS_SITE_IDS.join(","));
  url.searchParams.set("parameterCd", USGS_PARAMETER_CODES.join(","));
  url.searchParams.set("period", "PT6H");

  const payload = await fetchJson(url, "river");
  const stations = parseUsgsInstantaneousValues(payload);
  return { stations, asOf: retrievedAtOf(stations, "river") };
}

async function fetchAirSnapshot(): Promise<DomainSnapshot> {
  const apiKey = process.env["OPENAQ_API_KEY"];
  if (apiKey === undefined || apiKey.length === 0) {
    // Explicit, and scoped to air: a missing air credential must not stop
    // river requests, and it must not silently serve a fixture either.
    throw new SourceUnavailableError("air", "OPENAQ_API_KEY is not configured");
  }

  // ONE REQUEST PER LOCATION, not a comma-list filter.
  //
  // `/v3/locations?id=678,1289,627` answers 200 and ignores the filter: it
  // returns the first page of every location OpenAQ knows about. Asking for
  // three Sacramento monitors and receiving a hundred arbitrary ones, with a
  // success status, is worse than an error — an error refuses, and this
  // would have built a confident dashboard about the wrong continent.
  const results: unknown[] = [];
  const hours: Record<string, unknown> = {};

  for (const location of OPENAQ_LOCATIONS) {
    const url = new URL(
      `https://api.openaq.org/v3/locations/${String(location.id)}`,
    );
    const payload = await fetchJson(url, "air", apiKey);
    results.push(onlyLocation(payload, location.id));

    for (const sensorId of [location.pm25, location.ozone]) {
      const hoursUrl = new URL(
        `https://api.openaq.org/v3/sensors/${String(sensorId)}/hours`,
      );
      hoursUrl.searchParams.set("limit", "6");
      hours[String(sensorId)] = await fetchJson(hoursUrl, "air", apiKey);
    }
  }

  const retrievedAt = new Date().toISOString();
  const stations = parseOpenAqHourlySnapshot({
    retrievedAt,
    locations: { results },
    hours,
  });
  return { stations, asOf: retrievedAt };
}

/**
 * The location this request asked for, or a refusal.
 *
 * The durable half of the comma-list fix. Correct ids are not enough: a
 * response is only usable if it contains what was requested, and a 200 is
 * not that promise. This checks the identity rather than trusting the
 * status, so a filter the API decides to ignore — this one, or the next one
 * — fails closed instead of quietly substituting other stations.
 */
function onlyLocation(payload: unknown, expectedId: number): unknown {
  const results =
    typeof payload === "object" && payload !== null
      ? (payload as { results?: unknown }).results
      : undefined;
  if (!Array.isArray(results)) {
    throw new SourceUnavailableError("air", "location response had no results");
  }

  const match = results.find(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      (entry as { id?: unknown }).id === expectedId,
  );
  if (match === undefined) {
    throw new SourceUnavailableError(
      "air",
      `location ${String(expectedId)} was not in its own response`,
    );
  }
  return match;
}

/** The source's own retrieval time, which every station carries. */
function retrievedAtOf(
  stations: readonly Station[],
  domain: DomainKey,
): string {
  const asOf = stations[0]?.retrievedAt;
  if (asOf === undefined) throw new SourceUnavailableError(domain);
  return asOf;
}

async function fetchJson(
  url: URL,
  domain: DomainKey,
  apiKey?: string,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: "application/json",
        ...(apiKey === undefined ? {} : { "X-API-Key": apiKey }),
      },
      // No retries in the request path: a reader waiting on a page should
      // be told quickly, not kept waiting through a second attempt.
      cache: "no-store",
    });

    if (!response.ok) {
      throw new SourceUnavailableError(
        domain,
        `HTTP ${String(response.status)}`,
      );
    }

    const text = await readBounded(response, domain);
    return JSON.parse(text) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read the body with a hard ceiling, incrementally.
 *
 * Content-Length is a claim, not a fact — an upstream can omit it or lie —
 * so the bound is enforced against bytes actually received.
 */
async function readBounded(
  response: Response,
  domain: DomainKey,
): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new SourceUnavailableError(domain);

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new SourceUnavailableError(
        domain,
        `response exceeded ${String(MAX_RESPONSE_BYTES)} bytes`,
      );
    }
    chunks.push(value);
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}
