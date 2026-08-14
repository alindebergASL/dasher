import { describe, expect, it } from "vitest";

import {
  findReachabilityProblems,
  reachableFrom,
  type PackageNode,
  type ReachabilityDeclaration,
} from "./reachability";

function pkg(name: string, imports: readonly string[] = []): PackageNode {
  return { name, directory: `packages/${name}`, imports };
}

const noDeclaration: ReachabilityDeclaration = { roots: [], unreachable: [] };

describe("reachableFrom", () => {
  it("follows imports transitively", () => {
    const packages = [pkg("web", ["a"]), pkg("a", ["b"]), pkg("b"), pkg("far")];
    expect([...reachableFrom(packages, ["web"])].sort()).toEqual([
      "a",
      "b",
      "web",
    ]);
  });

  it("terminates on an import cycle", () => {
    // Two packages importing each other, reachable from nothing. A naive
    // depth-first walk here recurses until the stack gives out, which would
    // make the gate crash rather than report — and a crashing gate gets
    // switched off exactly as fast as a permanently red one.
    const packages = [pkg("a", ["b"]), pkg("b", ["a"]), pkg("web")];
    expect([...reachableFrom(packages, ["web"])]).toEqual(["web"]);
  });

  it("terminates on a cycle that a root reaches", () => {
    const packages = [pkg("web", ["a"]), pkg("a", ["b"]), pkg("b", ["a"])];
    expect([...reachableFrom(packages, ["web"])].sort()).toEqual([
      "a",
      "b",
      "web",
    ]);
  });

  it("reaches nothing through a root that does not exist", () => {
    expect([...reachableFrom([pkg("a")], ["ghost"])]).toEqual([]);
  });
});

describe("findReachabilityProblems", () => {
  it("accepts a repository where every package is reachable", () => {
    const packages = [pkg("web", ["a"]), pkg("a")];
    expect(
      findReachabilityProblems(packages, { roots: ["web"], unreachable: [] }),
    ).toEqual([]);
  });

  it("reports a package no root reaches", () => {
    // The case the gate exists for: a package is added, or its last importer is
    // deleted, and nothing else in the repository notices.
    const packages = [pkg("web"), pkg("stranded")];
    expect(
      findReachabilityProblems(packages, { roots: ["web"], unreachable: [] }),
    ).toEqual([{ kind: "undeclared_orphan", name: "stranded" }]);
  });

  it("accepts an orphan that is declared", () => {
    const packages = [pkg("web"), pkg("stranded")];
    expect(
      findReachabilityProblems(packages, {
        roots: ["web"],
        unreachable: [
          { name: "stranded", reason: "not wired yet", since: "2026-08-14" },
        ],
      }),
    ).toEqual([]);
  });

  it("reports a declaration that has become untrue", () => {
    // The direction that rots. Once something is wired up, its exemption is a
    // false statement about the repository, and a file full of false statements
    // stops being read.
    const packages = [pkg("web", ["wired"]), pkg("wired")];
    expect(
      findReachabilityProblems(packages, {
        roots: ["web"],
        unreachable: [
          { name: "wired", reason: "not wired yet", since: "2026-08-14" },
        ],
      }),
    ).toEqual([{ kind: "stale_exemption", name: "wired" }]);
  });

  it("counts a package reachable from a tooling root as reachable", () => {
    const packages = [pkg("web"), pkg("tool", ["helper"]), pkg("helper")];
    expect(
      findReachabilityProblems(packages, {
        roots: ["web", "tool"],
        unreachable: [],
      }),
    ).toEqual([]);
  });

  it("reports a root naming no package", () => {
    expect(
      findReachabilityProblems([pkg("web")], {
        roots: ["web", "ghost"],
        unreachable: [],
      }),
    ).toEqual([{ kind: "unknown_root", name: "ghost" }]);
  });

  it("reports an exemption naming no package", () => {
    expect(
      findReachabilityProblems([pkg("web")], {
        roots: ["web"],
        unreachable: [{ name: "deleted", reason: "gone", since: "2026-08-14" }],
      }),
    ).toEqual([{ kind: "unknown_exemption", name: "deleted" }]);
  });

  it("reports the same package exempted twice", () => {
    const packages = [pkg("web"), pkg("stranded")];
    expect(
      findReachabilityProblems(packages, {
        roots: ["web"],
        unreachable: [
          { name: "stranded", reason: "one", since: "2026-08-14" },
          { name: "stranded", reason: "two", since: "2026-08-14" },
        ],
      }),
    ).toEqual([{ kind: "duplicate_exemption", name: "stranded" }]);
  });

  it("reports every problem rather than stopping at the first", () => {
    const packages = [pkg("web"), pkg("one"), pkg("two")];
    const problems = findReachabilityProblems(packages, {
      roots: ["web", "ghost"],
      unreachable: [],
    });
    expect(problems).toHaveLength(3);
    expect(problems.map((problem) => problem.kind).sort()).toEqual([
      "undeclared_orphan",
      "undeclared_orphan",
      "unknown_root",
    ]);
  });

  it("reports every package when nothing is declared at all", () => {
    // An empty declaration must not read as permission. Deleting the file's
    // contents should fail loudly rather than disable the check.
    const packages = [pkg("web"), pkg("a")];
    expect(findReachabilityProblems(packages, noDeclaration)).toHaveLength(2);
  });
});
