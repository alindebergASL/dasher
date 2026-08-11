/**
 * `invalid_timezone` is decided by membership in the pinned `tzdb 2025b` table,
 * not by name syntax.
 */

import { describe, expect, it } from "vitest";

import { compareUtf8 } from "./canonical";
import {
  CalculationFailure,
  canonicalizeDocument,
  parseCalculationGraph,
  parseMetricContractSet,
} from "./index";
import { TZDB_2025B_ZONE_NAMES, isPinnedIanaZoneName } from "./timezones";
import { R7_CONTRACT_SET_BYTES, R7_GRAPH_BYTES } from "./r7-fixtures";

/** Reparses the R7 graph with one replaced timezone. */
function parseGraphWithZone(zone: string): void {
  const graph = JSON.parse(R7_GRAPH_BYTES) as Record<string, unknown>;
  graph.timezone = zone;
  const document = canonicalizeDocument(graph);
  parseCalculationGraph(document.value, document.canonicalText);
}

/** Reparses the R7 contract set with one replaced timezone. */
function parseContractWithZone(zone: string): void {
  const set = JSON.parse(R7_CONTRACT_SET_BYTES) as Record<string, unknown>;
  const contracts = set.contracts as Record<string, unknown>[];
  (contracts[0] as Record<string, unknown>).timezone = zone;
  const document = canonicalizeDocument(set);
  parseMetricContractSet(document.value, document.canonicalText);
}

function expectInvalidTimezone(run: () => void): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(CalculationFailure);
    expect((error as CalculationFailure).code).toBe("invalid_timezone");
    return;
  }
  throw new Error("expected invalid_timezone");
}

/* The exact zone the plan's R7 fixture pins, plus zones the suite already uses. */
const PLAN_ZONES = ["UTC", "Europe/Berlin"] as const;

/* Syntactically well-formed names that no tzdb release defines. */
const NONEXISTENT_ZONES = [
  "Europe/Atlantis",
  "America/Nowhere",
  "Asia/Not_A_City",
  "Mars/Phobos",
  "Etc/GMT+15",
  "utc",
  "UTC/",
  "Europe/berlin",
  "Europe_Berlin",
  "GMT+0100",
] as const;

describe("pinned tzdb 2025b zone table", () => {
  it("is frozen, sorted, and duplicate-free", () => {
    expect(Object.isFrozen(TZDB_2025B_ZONE_NAMES)).toBe(true);
    expect(new Set(TZDB_2025B_ZONE_NAMES).size).toBe(
      TZDB_2025B_ZONE_NAMES.length,
    );
    for (let index = 1; index < TZDB_2025B_ZONE_NAMES.length; index += 1) {
      const previous = TZDB_2025B_ZONE_NAMES[index - 1] as string;
      const current = TZDB_2025B_ZONE_NAMES[index] as string;
      expect([previous, current, compareUtf8(previous, current)]).toEqual([
        previous,
        current,
        -1,
      ]);
    }
  });

  it("contains the plan's fixture zone and ordinary IANA names", () => {
    for (const zone of [
      ...PLAN_ZONES,
      "America/New_York",
      "Asia/Kolkata",
      "Asia/Calcutta",
      "Australia/Sydney",
      "Etc/GMT+12",
      "US/Pacific",
      "Pacific/Auckland",
    ]) {
      expect([zone, isPinnedIanaZoneName(zone)]).toEqual([zone, true]);
    }
  });

  it("excludes every syntactically valid nonexistent name", () => {
    for (const zone of NONEXISTENT_ZONES) {
      expect([zone, isPinnedIanaZoneName(zone)]).toEqual([zone, false]);
    }
    expect(isPinnedIanaZoneName(null)).toBe(false);
    expect(isPinnedIanaZoneName(42)).toBe(false);
  });

  it("resolves no inherited member as a zone name", () => {
    for (const name of ["toString", "constructor", "__proto__"]) {
      expect([name, isPinnedIanaZoneName(name)]).toEqual([name, false]);
    }
  });
});

describe("graph and contract timezone validation", () => {
  it("admits a pinned zone in the graph and the contract", () => {
    for (const zone of PLAN_ZONES) {
      expect(() => parseGraphWithZone(zone)).not.toThrow();
      expect(() => parseContractWithZone(zone)).not.toThrow();
    }
  });

  it("denies a nonexistent graph timezone with invalid_timezone", () => {
    for (const zone of NONEXISTENT_ZONES) {
      expectInvalidTimezone(() => parseGraphWithZone(zone));
    }
  });

  it("denies a nonexistent contract timezone with invalid_timezone", () => {
    for (const zone of NONEXISTENT_ZONES) {
      expectInvalidTimezone(() => parseContractWithZone(zone));
    }
  });

  it("still denies a non-pinned tzdb release", () => {
    const graph = JSON.parse(R7_GRAPH_BYTES) as Record<string, unknown>;
    graph.tzdb_version = "2025a";
    const document = canonicalizeDocument(graph);
    expectInvalidTimezone(() =>
      parseCalculationGraph(document.value, document.canonicalText),
    );
  });
});
