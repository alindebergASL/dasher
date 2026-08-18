import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import liveCapture from "../../../fixtures/usgs/live-capture-2026-08-18.json";
import {
  clearSourceCache,
  loadDomainSnapshot,
  SourceUnavailableError,
  sourceMode,
} from "./source-runtime";

/**
 * The runtime's properties, exercised against a stubbed `fetch` rather than a
 * live upstream: a test that depends on waterservices.usgs.gov being reachable
 * and reporting something particular is a test that fails for reasons having
 * nothing to do with this code.
 *
 * The payload it serves is the committed VERBATIM CAPTURE, so what parses here
 * is what the service actually sends — the shape that the hand-authored
 * fixture, and therefore the parser, originally got wrong.
 */

const originalFetch = globalThis.fetch;
const originalMode = process.env["DASHER_SOURCE_MODE"];
const originalKey = process.env["OPENAQ_API_KEY"];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  clearSourceCache();
  process.env["DASHER_SOURCE_MODE"] = "live";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalMode === undefined) delete process.env["DASHER_SOURCE_MODE"];
  else process.env["DASHER_SOURCE_MODE"] = originalMode;
  if (originalKey === undefined) delete process.env["OPENAQ_API_KEY"];
  else process.env["OPENAQ_API_KEY"] = originalKey;
  clearSourceCache();
  vi.restoreAllMocks();
});

describe("fixture mode", () => {
  it("never reaches the network, whatever the upstream would have said", async () => {
    process.env["DASHER_SOURCE_MODE"] = "fixture";
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const snapshot = await loadDomainSnapshot("river");

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(snapshot.stations.length).toBeGreaterThan(0);
    expect(snapshot.asOf).toBe("2026-07-29T12:02:00.000Z");
    expect(sourceMode()).toBe("fixture");
  });

  it("is the default, so a missing setting cannot silently go live", async () => {
    delete process.env["DASHER_SOURCE_MODE"];
    expect(sourceMode()).toBe("fixture");
  });
});

describe("live mode, when the source answers", () => {
  it("fetches once, parses the real payload shape, and reports its asOf", async () => {
    const fetchSpy = vi.fn(async () => jsonResponse(liveCapture));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const snapshot = await loadDomainSnapshot("river");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(snapshot.stations.length).toBeGreaterThan(0);
    // The retrieval time the service reported, not one this process invented.
    expect(snapshot.asOf).toBe("2026-08-18T22:29:20.423Z");
  });

  it("reuses the snapshot inside the TTL instead of asking again", async () => {
    const fetchSpy = vi.fn(async () => jsonResponse(liveCapture));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const first = await loadDomainSnapshot("river");
    const second = await loadDomainSnapshot("river");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it("coalesces concurrent requests into one upstream call", async () => {
    // The case a TTL alone does not cover: ten readers arriving together,
    // before any of them has an answer to cache.
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchSpy = vi.fn(async () => {
      await gate;
      return jsonResponse(liveCapture);
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const all = Promise.all(
      Array.from({ length: 10 }, () => loadDomainSnapshot("river")),
    );
    release?.();
    const snapshots = await all;

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(new Set(snapshots).size).toBe(1);
  });

  it("does not cache a failure, so one bad minute is not five", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: "nope" }, 503))
      .mockResolvedValueOnce(jsonResponse(liveCapture));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await expect(loadDomainSnapshot("river")).rejects.toBeInstanceOf(
      SourceUnavailableError,
    );
    const recovered = await loadDomainSnapshot("river");

    expect(recovered.stations.length).toBeGreaterThan(0);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe("live mode, when the source does not", () => {
  it.each([
    ["a non-2xx status", async () => jsonResponse({ error: "x" }, 500)],
    ["an unauthorized status", async () => jsonResponse({ error: "x" }, 401)],
    [
      "a body that is not JSON",
      async () => new Response("<html>down for maintenance</html>"),
    ],
    [
      "a body that is JSON but not a USGS response",
      async () => jsonResponse({ value: { timeSeries: [] } }),
    ],
    [
      // Whitespace-padded on purpose: this body is a VALID USGS response
      // that would parse perfectly if it were read. The only thing that can
      // reject it is the byte ceiling, so removing the ceiling turns this
      // test red. The first version padded with a junk field instead, which
      // was also malformed — it passed for the wrong reason and let the
      // ceiling be deleted without complaint.
      "a body past the size ceiling",
      async () =>
        new Response(
          " ".repeat(6 * 1024 * 1024) + JSON.stringify(liveCapture),
          {
            headers: { "content-type": "application/json" },
          },
        ),
    ],
    [
      "a request that never completes",
      async () => {
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      },
    ],
  ])("refuses on %s", async (_label, responder) => {
    globalThis.fetch = vi.fn(responder) as unknown as typeof fetch;

    await expect(loadDomainSnapshot("river")).rejects.toBeInstanceOf(
      SourceUnavailableError,
    );
  });

  it("never falls back to the fixture when live", async () => {
    // The refusal is the point. Serving the committed sample here would
    // present a stale snapshot as current conditions.
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ error: "x" }, 500),
    ) as unknown as typeof fetch;

    await expect(loadDomainSnapshot("river")).rejects.toBeInstanceOf(
      SourceUnavailableError,
    );
  });

  it("says nothing about the cause in the message it carries", async () => {
    process.env["OPENAQ_API_KEY"] = "super-secret-key-value";
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ detail: "invalid api key super-secret-key-value" }, 401),
    ) as unknown as typeof fetch;

    const error = await loadDomainSnapshot("air").then(
      (): Error | undefined => undefined,
      (thrown: unknown) => (thrown instanceof Error ? thrown : undefined),
    );

    expect(error).toBeInstanceOf(SourceUnavailableError);
    expect(error?.message).not.toContain("super-secret-key-value");
    expect(JSON.stringify(error)).not.toContain("super-secret-key-value");
    expect(String(error?.stack)).not.toContain("super-secret-key-value");
  });
});

describe("the air loader's identity check", () => {
  /**
   * The defect a live check found, and the general fix for it.
   *
   * `/v3/locations?id=678,1289,627` answers 200 and ignores the filter,
   * returning the first page of every location OpenAQ knows about. The
   * original loader used that form with ids taken from the fixture — which
   * were themselves wrong entities (Del Norte, Denver, an Osceola County
   * fire station) — so a live air request would have built a confident
   * dashboard about arbitrary monitors on another continent. No status code
   * would have objected.
   */
  it("refuses a 200 that does not contain the location it asked for", async () => {
    process.env["OPENAQ_API_KEY"] = "test-key";

    // The substituted locations are COMPLETE AND PARSEABLE — real-looking
    // monitors with real-looking sensors, whose hours resolve. A loader that
    // took whatever came back would succeed here and build a dashboard about
    // the wrong places. Only checking the identity refuses, which is what
    // makes this test discriminating: an earlier version served malformed
    // substitutes, so the parser rejected them and the test passed without
    // the identity check existing at all.
    const substitute = (id: number, pm: number, o3: number) => ({
      id,
      name: `Somewhere Else ${String(id)}`,
      locality: "Elsewhere",
      timezone: "America/Los_Angeles",
      coordinates: { latitude: 10, longitude: 10 },
      isMobile: false,
      isMonitor: true,
      sensors: [
        {
          id: pm,
          name: "pm25 µg/m³",
          parameter: {
            id: 2,
            name: "pm25",
            units: "µg/m³",
            displayName: "PM2.5",
          },
        },
        {
          id: o3,
          name: "o3 ppm",
          parameter: { id: 10, name: "o3", units: "ppm", displayName: "Ozone" },
        },
      ],
    });
    const hoursBody = {
      results: [
        {
          value: 5,
          period: { datetimeTo: { utc: "2026-08-18T10:00:00Z" } },
        },
        {
          value: 6,
          period: { datetimeTo: { utc: "2026-08-18T11:00:00Z" } },
        },
      ],
    };

    globalThis.fetch = vi.fn(async (input: unknown) =>
      String(input).includes("/hours")
        ? jsonResponse(hoursBody)
        : jsonResponse({
            results: [
              substitute(9001, 1556, 1548),
              substitute(9002, 2309, 2305),
            ],
          }),
    ) as unknown as typeof fetch;

    await expect(loadDomainSnapshot("air")).rejects.toBeInstanceOf(
      SourceUnavailableError,
    );
  });

  it("asks for each location on its own endpoint, never a comma-list filter", async () => {
    process.env["OPENAQ_API_KEY"] = "test-key";
    const urls: string[] = [];
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = String(input);
      urls.push(url);
      return jsonResponse({ results: [] });
    }) as unknown as typeof fetch;

    await loadDomainSnapshot("air").catch(() => undefined);

    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url).not.toMatch(/[?&]id=/u);
    }
    // The verified Sacramento-area locations, each addressed directly.
    expect(urls[0]).toContain("/v3/locations/678");
  });
});

describe("the air credential", () => {
  it("fails air explicitly when absent, without touching the network", async () => {
    delete process.env["OPENAQ_API_KEY"];
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await expect(loadDomainSnapshot("air")).rejects.toBeInstanceOf(
      SourceUnavailableError,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("leaves river working when the air credential is missing", async () => {
    // Scoped failure: one domain's missing credential is not an outage.
    delete process.env["OPENAQ_API_KEY"];
    globalThis.fetch = vi.fn(async () =>
      jsonResponse(liveCapture),
    ) as unknown as typeof fetch;

    const snapshot = await loadDomainSnapshot("river");
    expect(snapshot.stations.length).toBeGreaterThan(0);
  });

  it("sends the key as a header and never in the URL", async () => {
    process.env["OPENAQ_API_KEY"] = "header-only-key";
    const seen: Array<{ url: string; headers: Headers }> = [];
    globalThis.fetch = vi.fn(async (input: unknown, init: unknown) => {
      seen.push({
        url: String(input),
        headers: new Headers((init as RequestInit).headers),
      });
      return jsonResponse({ results: [] });
    }) as unknown as typeof fetch;

    // It will fail at parsing — an empty locations list is not a snapshot —
    // but the request it made first is what this asserts.
    await loadDomainSnapshot("air").catch(() => undefined);

    expect(seen.length).toBeGreaterThan(0);
    for (const request of seen) {
      expect(request.url).not.toContain("header-only-key");
      expect(request.headers.get("X-API-Key")).toBe("header-only-key");
    }
  });
});
