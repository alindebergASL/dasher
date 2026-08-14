import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { describeProblem, findReachabilityProblems } from "./reachability";
import {
  readReachabilityDeclaration,
  readWorkspacePackages,
} from "./workspace";

/**
 * The gate, run against this repository rather than against a fixture.
 *
 * It lives in the test suite so it runs wherever the suite runs, with no CI
 * wiring to forget. The unit tests beside it prove the analysis is right; this
 * proves the repository currently satisfies it.
 */

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

describe("workspace reachability", () => {
  it("agrees with reachability.json", async () => {
    const [packages, declaration] = await Promise.all([
      readWorkspacePackages(repositoryRoot),
      readReachabilityDeclaration(repositoryRoot),
    ]);

    const problems = findReachabilityProblems(packages, declaration);
    expect(problems.map(describeProblem)).toEqual([]);
  });

  it("finds the workspace at all", async () => {
    // Without this, a scanner that silently returned nothing would report a
    // clean repository forever. An empty result is the one answer that must
    // never read as success.
    const packages = await readWorkspacePackages(repositoryRoot);
    expect(packages.length).toBeGreaterThan(1);
    expect(packages.map((node) => node.name)).toContain("@dasher/web");
  });

  it("sees the product's real import edges", async () => {
    // Anchors the scanner against a known truth. If the import regex stops
    // matching, every package looks like an orphan and the failure is obvious
    // rather than the opposite — but a silent narrowing that still matched
    // *something* would not be, so one real edge is pinned.
    const packages = await readWorkspacePackages(repositoryRoot);
    const web = packages.find((node) => node.name === "@dasher/web");
    expect(web?.imports).toContain("@dasher/planner");
  });
});
