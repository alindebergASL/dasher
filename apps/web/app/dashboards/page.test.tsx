// @vitest-environment node
import type * as ControlPlane from "@dasher/control-plane";
import type * as Session from "../session";

import { DashboardRepositoryError } from "@dasher/control-plane";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

import YourDashboards from "./page";

/*
 * Same contract as /d/[id], softer answer: a well-formed credential the
 * database refuses renders the signed-out note — indistinguishable from
 * having no session at all — rather than crashing the page. This pins the
 * repository-facade vocabulary (`not_authenticated`) at the second of the two
 * call sites that briefly kept matching the seam's old `denied` and turned
 * every overnight-stale tab into a 500.
 */

vi.mock("../session", async (importOriginal) => ({
  ...(await importOriginal<typeof Session>()),
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

it("shows a dead session the signed-out note, not a server error", async () => {
  vi.stubEnv("DASHER_DATABASE_URL", "postgresql://u:p@localhost:5432/d");
  try {
    const page = await YourDashboards({ searchParams: Promise.resolve({}) });
    const html = renderToStaticMarkup(page);

    expect(html).toContain("Sign in");
    expect(html).not.toContain("Internal Server Error");
  } finally {
    vi.unstubAllEnvs();
  }
});
