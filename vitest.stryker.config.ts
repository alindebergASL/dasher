import { defineConfig } from "vitest/config";

/**
 * Test selection for the mutation run only.
 *
 * The composition rules live in `@dasher/river-domain` and are exercised from
 * both there and `@dasher/planner`, so mutating them has to run both suites or
 * the score measures the wrong thing. Nothing else discovers this file: each
 * package's own `vitest run` uses its own directory.
 */
export default defineConfig({
  test: {
    include: [
      "packages/planner/src/**/*.test.ts",
      "packages/river-domain/src/**/*.test.ts",
    ],
  },
});
