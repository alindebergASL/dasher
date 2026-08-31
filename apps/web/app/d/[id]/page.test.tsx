// @vitest-environment node
import type * as ControlPlane from "@dasher/control-plane";
import type * as Session from "../../session";

import { DashboardRepositoryError } from "@dasher/control-plane";
import { expect, it, vi } from "vitest";

import SavedDashboard from "./page";

/*
 * The one failure this file exists to pin: a WELL-FORMED credential the
 * database refuses must land on the same 404 as a dashboard that does not
 * exist.
 *
 * The page's own header documents why — distinguishing "bad credential" from
 * "no such dashboard" hands a token prober an oracle — and an e2e already
 * drives the full stack to the same assertion. This unit test exists because
 * the contract broke anyway, between those two: the repository facade started
 * translating the seam's `denied` into its own `not_authenticated`, the page
 * kept matching the old code, and every dead session became a 500. The e2e
 * would have caught it in CI; nothing caught it at the desk. This fails in
 * milliseconds instead.
 */

vi.mock("../../session", async (importOriginal) => ({
  ...(await importOriginal<typeof Session>()),
  // Parses fine, names nobody: the shape of an expired or forged cookie.
  readSessionCredential: async () => ({
    tokenKeyVersion: 1,
    token: Buffer.alloc(32, 7),
  }),
}));

vi.mock("@dasher/control-plane", async (importOriginal) => ({
  ...(await importOriginal<typeof ControlPlane>()),
  withDashboardRepository: async () => {
    throw new DashboardRepositoryError(
      "not_authenticated",
      "the presented credential was not accepted",
    );
  },
}));

it("answers a dead session with the same 404 as a missing dashboard", async () => {
  vi.stubEnv("DASHER_DATABASE_URL", "postgresql://u:p@localhost:5432/d");
  try {
    await expect(
      SavedDashboard({
        params: Promise.resolve({ id: "6b7a2c1d-0e5f-4a3b-8c9d-1e2f3a4b5c6d" }),
      }),
    ).rejects.toMatchObject({
      // Next's notFound() sentinel. Asserting the digest rather than "it
      // threw" keeps a genuine crash from passing as a refusal.
      digest: expect.stringContaining("404") as unknown,
    });
  } finally {
    vi.unstubAllEnvs();
  }
});
