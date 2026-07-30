import { expect, it } from "vitest";

import { parsePostgresIntegrationEnv } from "../src/index.js";

it("passes fail-closed preflight before the future PostgreSQL harness runs", () => {
  const config = parsePostgresIntegrationEnv(process.env);

  expect(config.hmacKey).toHaveLength(32);
});
