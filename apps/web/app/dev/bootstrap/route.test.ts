// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";

import { GET, POST } from "./route";

/**
 * The switch, tested directly.
 *
 * The end-to-end suite exercises this route with the switch on, which is the
 * only way it can: it needs the cookie. That leaves the branch that actually
 * matters untested there — the one where the route must not mint a session at
 * all. This handler hands an authenticated session to anyone who can reach the
 * URL, so "off by default" is the security property, and a property nothing
 * asserts is a property nobody will notice losing.
 */

const original = process.env["DASHER_DEV_BOOTSTRAP"];

afterEach(() => {
  if (original === undefined) delete process.env["DASHER_DEV_BOOTSTRAP"];
  else process.env["DASHER_DEV_BOOTSTRAP"] = original;
});

describe("the development bootstrap", () => {
  it("is absent unless explicitly switched on", async () => {
    delete process.env["DASHER_DEV_BOOTSTRAP"];

    const response = await POST();

    // 404 rather than 403: where this is off, the route does not exist as far
    // as a caller is concerned, and "forbidden" would confirm that it is here.
    expect(response.status).toBe(404);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it.each([["0"], ["true"], ["yes"], [""], ["1 "]])(
    "refuses the near-miss value %o",
    async (value) => {
      // Exact match only. A switch that accepts "true" accepts a typo that
      // looks deliberate, and this is not a setting to be generous about.
      process.env["DASHER_DEV_BOOTSTRAP"] = value;

      const response = await POST();

      expect(response.status).toBe(404);
      expect(response.headers.get("set-cookie")).toBeNull();
    },
  );

  it("does not treat GET as a way to start a session", async () => {
    process.env["DASHER_DEV_BOOTSTRAP"] = "1";

    const response = GET();

    expect(response.status).toBe(405);
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});
