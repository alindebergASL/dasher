/**
 * `@dasher/repo-graph` — what imports what, and whether the repository agrees
 * with its own declaration about it.
 *
 * Tooling. Nothing in the product imports this, which is why `reachability.json`
 * names it a root rather than an exemption: a root is something allowed to be
 * an entry point, and a check that runs over the repository is one.
 */

export {
  describeProblem,
  findReachabilityProblems,
  reachableFrom,
  type PackageNode,
  type ReachabilityDeclaration,
  type ReachabilityProblem,
  type UnreachableDeclaration,
} from "./reachability";

export {
  readReachabilityDeclaration,
  readWorkspacePackages,
} from "./workspace";
