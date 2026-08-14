import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import type { PackageNode, ReachabilityDeclaration } from "./reachability";

/**
 * Reads the real workspace: which packages exist and which import which.
 *
 * Edges come from source imports rather than from `package.json` dependencies.
 * A declared dependency is a claim; an import is a fact, and an unused declared
 * dependency would make a package look reachable when nothing actually reaches
 * it — the precise mistake this gate exists to catch.
 *
 * Type-only imports count. `import type { X } from "@dasher/y"` is real
 * coupling: the package cannot be deleted while it is written.
 *
 * Nothing here spawns a process. The generated-code gate forbids execution
 * sinks in first-party source, and a repository-hygiene check is not a reason
 * to make an exception.
 */

const sourceFilePattern = /\.tsx?$/u;
const workspaceImportPattern = /["'](@dasher\/[a-z0-9-]+)["']/gu;
const skippedDirectories = new Set(["node_modules", "dist", ".next"]);

/** Directory globs from `pnpm-workspace.yaml`, as literal prefixes. */
async function readWorkspaceDirectories(
  repositoryRoot: string,
): Promise<readonly string[]> {
  const text = await readFile(
    join(repositoryRoot, "pnpm-workspace.yaml"),
    "utf8",
  );
  const directories: string[] = [];
  let inPackages = false;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trimEnd();
    if (/^packages:\s*$/u.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      const entry = /^\s+-\s+(.+?)\s*$/u.exec(line);
      if (entry?.[1] === undefined) {
        if (line.trim() !== "") break;
        continue;
      }
      directories.push(entry[1].replace(/\/\*$/u, ""));
    }
  }

  if (directories.length === 0) {
    throw new Error("pnpm-workspace.yaml declares no package directories");
  }
  return directories;
}

async function collectSourceFiles(
  directory: string,
  found: string[] = [],
): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || skippedDirectories.has(entry.name)) {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectSourceFiles(path, found);
    } else if (sourceFilePattern.test(entry.name)) {
      found.push(path);
    }
  }
  return found;
}

export async function readWorkspacePackages(
  repositoryRoot: string,
): Promise<readonly PackageNode[]> {
  const root = resolve(repositoryRoot);
  const packages: PackageNode[] = [];

  for (const parent of await readWorkspaceDirectories(root)) {
    let entries;
    try {
      entries = await readdir(join(root, parent), { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const directory = join(root, parent, entry.name);

      let manifest: { name?: unknown };
      try {
        manifest = JSON.parse(
          await readFile(join(directory, "package.json"), "utf8"),
        ) as { name?: unknown };
      } catch {
        continue;
      }
      if (typeof manifest.name !== "string") continue;

      const imports = new Set<string>();
      for (const file of await collectSourceFiles(directory)) {
        const source = await readFile(file, "utf8");
        for (const match of source.matchAll(workspaceImportPattern)) {
          const imported = match[1];
          if (imported !== undefined && imported !== manifest.name) {
            imports.add(imported);
          }
        }
      }

      packages.push({
        name: manifest.name,
        directory: relative(root, directory),
        imports: [...imports].sort(),
      });
    }
  }

  return packages.sort((left, right) => (left.name < right.name ? -1 : 1));
}

export async function readReachabilityDeclaration(
  repositoryRoot: string,
): Promise<ReachabilityDeclaration> {
  const text = await readFile(
    join(resolve(repositoryRoot), "reachability.json"),
    "utf8",
  );
  const parsed = JSON.parse(text) as Partial<ReachabilityDeclaration>;

  if (!Array.isArray(parsed.roots) || !Array.isArray(parsed.unreachable)) {
    throw new Error(
      "reachability.json must declare a roots array and an unreachable array",
    );
  }
  return { roots: parsed.roots, unreachable: parsed.unreachable };
}
