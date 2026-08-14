/**
 * Which workspace packages are reachable from a declared entry point, and
 * which are not.
 *
 * The failure this exists to stop is silent accumulation. `@dasher/control-plane`
 * reached 71,748 lines and `@dasher/calculation-engine` 17,372 with nothing
 * importing either, while every gate stayed green — because a package with no
 * importers still typechecks, still lints, and still passes its own tests. The
 * suite reports on the code that exists, not on whether anything asks for it.
 *
 * A gate that simply failed on the first orphan would be red on the day it
 * landed, since both of those are deliberate today, and a permanently red gate
 * gets deleted within a week. So the check is against a *declaration* rather
 * than against zero: unreachable packages are allowed, but each must be written
 * down with a reason and a date. What that converts is not the existence of
 * dead weight but its silence — adding one becomes a diff someone reviews.
 *
 * It fails in both directions on purpose. An orphan nobody declared is the
 * obvious case; an entry that is no longer true is the one that rots. Once a
 * package gets wired up, its exemption is a stale claim about the repository,
 * and leaving it there teaches readers the file is decorative.
 */

export interface PackageNode {
  /** Workspace package name, e.g. `@dasher/planner`. */
  readonly name: string;
  /** Repository-relative directory, for messages. */
  readonly directory: string;
  /** Workspace package names this one imports in its source. */
  readonly imports: readonly string[];
}

export interface UnreachableDeclaration {
  readonly name: string;
  readonly reason: string;
  /** ISO date the exemption was recorded, so staleness is visible. */
  readonly since: string;
}

export interface ReachabilityDeclaration {
  /**
   * Entry points reachability is measured from: the product itself, plus
   * tooling that nothing is supposed to import.
   */
  readonly roots: readonly string[];
  readonly unreachable: readonly UnreachableDeclaration[];
}

export type ReachabilityProblem =
  /** A package no root reaches, and no declaration accounts for. */
  | { readonly kind: "undeclared_orphan"; readonly name: string }
  /** A declared orphan that a root now reaches; the entry is no longer true. */
  | { readonly kind: "stale_exemption"; readonly name: string }
  /** A root that names no workspace package. */
  | { readonly kind: "unknown_root"; readonly name: string }
  /** An exemption that names no workspace package. */
  | { readonly kind: "unknown_exemption"; readonly name: string }
  /** The same package exempted twice. */
  | { readonly kind: "duplicate_exemption"; readonly name: string };

/**
 * Every package a root reaches, following imports transitively.
 *
 * Iterative rather than recursive, and guarded by the visited set, so an import
 * cycle terminates instead of overflowing the stack.
 */
export function reachableFrom(
  packages: readonly PackageNode[],
  roots: readonly string[],
): ReadonlySet<string> {
  const byName = new Map(packages.map((node) => [node.name, node]));
  const reached = new Set<string>();
  const pending = [...roots];

  while (pending.length > 0) {
    const name = pending.pop();
    if (name === undefined || reached.has(name)) {
      continue;
    }
    const node = byName.get(name);
    if (node === undefined) {
      // An unknown root is reported separately; it simply reaches nothing.
      continue;
    }
    reached.add(name);
    pending.push(...node.imports);
  }

  return reached;
}

/**
 * Compares the real import graph against what the repository declares.
 *
 * Returns every disagreement rather than the first, so one run tells you the
 * whole story.
 */
export function findReachabilityProblems(
  packages: readonly PackageNode[],
  declaration: ReachabilityDeclaration,
): readonly ReachabilityProblem[] {
  const problems: ReachabilityProblem[] = [];
  const known = new Set(packages.map((node) => node.name));

  for (const root of declaration.roots) {
    if (!known.has(root)) {
      problems.push({ kind: "unknown_root", name: root });
    }
  }

  const seenExemptions = new Set<string>();
  for (const entry of declaration.unreachable) {
    if (!known.has(entry.name)) {
      problems.push({ kind: "unknown_exemption", name: entry.name });
    }
    if (seenExemptions.has(entry.name)) {
      problems.push({ kind: "duplicate_exemption", name: entry.name });
    }
    seenExemptions.add(entry.name);
  }

  const reached = reachableFrom(packages, declaration.roots);

  for (const node of packages) {
    const exempted = seenExemptions.has(node.name);
    if (reached.has(node.name)) {
      if (exempted) {
        problems.push({ kind: "stale_exemption", name: node.name });
      }
      continue;
    }
    if (!exempted) {
      problems.push({ kind: "undeclared_orphan", name: node.name });
    }
  }

  return problems;
}

/** A message naming the package, what is wrong, and what to do about it. */
export function describeProblem(problem: ReachabilityProblem): string {
  switch (problem.kind) {
    case "undeclared_orphan":
      return `${problem.name} is imported by nothing reachable from a declared root. Wire it up, delete it, or record it in reachability.json with a reason and a date.`;
    case "stale_exemption":
      return `${problem.name} is listed as unreachable in reachability.json, but a declared root now reaches it. Remove the entry.`;
    case "unknown_root":
      return `reachability.json names ${problem.name} as a root, but no workspace package has that name.`;
    case "unknown_exemption":
      return `reachability.json lists ${problem.name} as unreachable, but no workspace package has that name. Remove the entry.`;
    case "duplicate_exemption":
      return `reachability.json lists ${problem.name} more than once.`;
  }
}
