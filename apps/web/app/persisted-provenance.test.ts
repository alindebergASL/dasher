// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DETERMINISTIC_LEDGER_PLANNER } from "@dasher/planner";

import { planDashboard } from "./actions";
import { clearSourceCache } from "./source-runtime";
// Static, type-only namespace imports for the mock factories. The
// generated-code gate forbids the dynamic-import form anywhere in first-party
// source and does not treat test files differently — correctly, since it is a
// text sweep and an exception for tests is an exception. `vi.mock` is hoisted
// above these, so nothing needs to be loaded lazily to be mocked.
import type * as Domains from "./domains";
import type * as SourceRuntime from "./source-runtime";

/**
 * What the persisted record says built a dashboard, against what actually did.
 *
 * The reviewed version of this change derived the record from the REQUEST: a
 * combined request named two domains, so two planners were recorded. A combined
 * dashboard can be built from one of them — the other source being down is an
 * ordinary state this product handles by name — and in that case the record
 * claimed a planner that never executed.
 *
 * The two sensor domains hold the same deterministic planner today, so nothing
 * in the shipping configuration could have exposed it. These tests give them
 * distinct ids, which is what makes the difference between "requested" and
 * "ran" observable at all.
 */

let unavailableDomains: readonly ("river" | "air")[] = [];

const saved: Array<{ provider: string; model: string }> = [];

vi.mock("./source-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof SourceRuntime>();
  return {
    ...actual,
    loadDomainSnapshot: async (domain: "river" | "air") => {
      if (unavailableDomains.includes(domain)) {
        throw new actual.SourceUnavailableError(domain);
      }
      return actual.loadDomainSnapshot(domain);
    },
  };
});

/**
 * Distinct planner ids per domain, wrapped around the real fake so every plan
 * the compiler receives is a real one. Only the identity differs.
 */
vi.mock("./domains", async (importOriginal) => {
  const actual = await importOriginal<typeof Domains>();
  const tag = (entry: Domains.DomainEntry): Domains.DomainEntry => ({
    ...entry,
    provider: {
      id: `planner-${entry.key}`,
      usesModel: false,
      plan: (request) => entry.provider.plan(request),
    },
  });
  const catalog = {
    river: tag(actual.DOMAIN_CATALOG.river),
    air: tag(actual.DOMAIN_CATALOG.air),
  };
  return {
    ...actual,
    DOMAIN_CATALOG: catalog,
    classifyRequest: (text: string): Domains.DomainDecision => {
      const decision = actual.classifyRequest(text);
      if (decision.kind === "domain") {
        return { kind: "domain", domain: catalog[decision.domain.key] };
      }
      if (decision.kind === "domains") {
        return {
          kind: "domains",
          domains: [
            catalog[decision.domains[0].key],
            catalog[decision.domains[1].key],
          ],
        };
      }
      return decision;
    },
  };
});

vi.mock("./database", () => ({
  isPersistenceConfigured: () => true,
  getPool: () => ({}),
}));

vi.mock("./session", () => ({
  readSessionCredential: async () => ({ token: "t", tokenKeyVersion: 1 }),
}));

vi.mock("@dasher/control-plane", () => ({
  withDashboardRepository: async (
    _pool: unknown,
    _credential: unknown,
    use: (repository: {
      save: (input: { provider: string; model: string }) => Promise<unknown>;
    }) => Promise<unknown>,
  ) =>
    use({
      save: async (input) => {
        saved.push({ provider: input.provider, model: input.model });
        return { dashboardId: "saved-id" };
      },
    }),
}));

const COMBINED = "Compare river conditions and air quality near Sacramento";

beforeEach(() => {
  saved.length = 0;
  unavailableDomains = [];
  clearSourceCache();
});

describe("the persisted record names the planners that ran", () => {
  it("records both when both sources load", async () => {
    const result = await planDashboard(COMBINED);

    expect(result.ok).toBe(true);
    expect(saved).toStrictEqual([
      // The collapse is per field: one provider kind, two distinct planners.
      { provider: "deterministic", model: "planner-river+planner-air" },
    ]);
  });

  it.each([
    ["river", "planner-air"],
    ["air", "planner-river"],
  ])(
    "records only the planner that ran when %s is unavailable",
    async (down, expected) => {
      unavailableDomains = [down as "river" | "air"];

      const result = await planDashboard(COMBINED);

      // The dashboard is still built from what loaded, which is the behaviour
      // that made this defect reachable in the first place.
      expect(result.ok).toBe(true);
      expect(saved).toStrictEqual([
        { provider: "deterministic", model: expected },
      ]);
    },
  );

  it("persists nothing when neither source loads", async () => {
    unavailableDomains = ["river", "air"];

    const result = await planDashboard(COMBINED);

    expect(result.ok).toBe(false);
    expect(saved).toStrictEqual([]);
  });

  it("records the single planner for a single-source request", async () => {
    await planDashboard("Create a live dashboard monitoring river gauges");

    expect(saved).toStrictEqual([
      { provider: "deterministic", model: "planner-river" },
    ]);
  });

  it("names the planner, not the snapshot, for the operating ledger", async () => {
    // The ledger and enrollment are both `known-source` decisions, and the two
    // answer differently on purpose. Enrollment has no planner to ask; the
    // ledger runs one, so it derives its record like every other planned path.
    // Naming it with a literal was correct on the day it was written and would
    // have gone stale silently the day the ledger planner changed.
    await planDashboard("Operating spend by category");

    expect(saved).toStrictEqual([
      // `provider` comes from `usesModel: false`, and `model` from the
      // planner's own id — read from the planner here rather than restated, so
      // this follows a rename instead of outliving one.
      { provider: "deterministic", model: DETERMINISTIC_LEDGER_PLANNER.id },
    ]);
  });

  it("names the snapshot, not a planner, for the official enrollment source", async () => {
    // No planner runs on this path at all, so there is nothing to derive from
    // and the literal is the true answer rather than a stand-in.
    await planDashboard("Current student enrollment at UC Riverside");

    expect(saved).toStrictEqual([
      {
        provider: "ucr-institutional-research",
        model: "deterministic-enrollment-v1",
      },
    ]);
  });
});
