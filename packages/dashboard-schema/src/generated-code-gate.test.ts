/// <reference types="node" />

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import type { Dirent } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/*
 * Static regression tripwire only: this catches accidental source-level sinks,
 * but it does not prove runtime isolation or generated-code safety. The CLOSED
 * gate and its required controls remain authoritative in GENERATED_CODE_GATE.md.
 */

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const thisTestFile = fileURLToPath(import.meta.url);
const skippedDirectories = new Set([
  ".git",
  "node_modules",
  ".next",
  "test-results",
  "playwright-report",
]);
const sourceExtensionPattern = /\.(?:js|jsx|cjs|mjs|ts|tsx|cts|mts)$/;

const forbiddenPatterns = [
  {
    name: "eval",
    pattern:
      /(?:\beval|globalThis\s*(?:\.\s*eval|\[\s*["']eval["']\s*\]))\s*\(/,
  },
  {
    name: "Function constructor",
    pattern:
      /(?:(?:new\s+)?\bFunction|globalThis\s*(?:\.\s*Function|\[\s*["']Function["']\s*\]))\s*\(/,
  },
  { name: "dynamic import", pattern: /\bimport\s*\(/ },
  { name: "child_process", pattern: /\b(?:node:)?child_process\b/ },
  { name: "node:vm", pattern: /\bnode:vm\b/ },
  { name: "worker_threads", pattern: /\b(?:node:)?worker_threads\b/ },
  {
    name: "WebAssembly compile/instantiate",
    pattern: /\bWebAssembly\s*\.\s*(?:compile|instantiate)(?:Streaming)?\s*\(/,
  },
  { name: "Deno.Command", pattern: /\bDeno\s*\.\s*Command\s*\(/ },
  { name: "Bun.spawn", pattern: /\bBun\s*\.\s*spawn(?:Sync)?\s*\(/ },
  {
    name: "document.write",
    pattern: /\bdocument\s*\.\s*write(?:ln)?\s*\(/,
  },
  {
    name: "innerHTML",
    pattern: /(?:\.\s*innerHTML|\[\s*["']innerHTML["']\s*\])\s*=(?!=)/,
  },
  {
    name: "dangerouslySetInnerHTML",
    pattern: /\bdangerouslySetInnerHTML\b/,
  },
] as const;

function findForbiddenPrimitives(source: string): string[] {
  return forbiddenPatterns
    .filter(({ pattern }) => pattern.test(source))
    .map(({ name }) => name);
}

type DirectoryReader = (directory: string) => Dirent<string>[];

const readDirectoryEntries: DirectoryReader = (directory) =>
  readdirSync(directory, { encoding: "utf8", withFileTypes: true });

function isInsideRoot(canonicalRoot: string, canonicalPath: string): boolean {
  const relativePath = relative(canonicalRoot, canonicalPath);
  return (
    relativePath === "" ||
    (!isAbsolute(relativePath) && relativePath.split(/[\\/]/)[0] !== "..")
  );
}

function resolvesThroughSkippedDirectory(
  canonicalRoot: string,
  canonicalPath: string,
): boolean {
  return relative(canonicalRoot, canonicalPath)
    .split(/[\\/]/)
    .some((segment) => skippedDirectories.has(segment));
}

function firstPartySourceFiles(
  root = repoRoot,
  readDirectory: DirectoryReader = readDirectoryEntries,
): string[] {
  const canonicalRoot = realpathSync(root);
  const sourceFiles: string[] = [];
  const pendingDirectories: Array<{
    directory: string;
    ancestorRealPaths: ReadonlySet<string>;
  }> = [{ directory: root, ancestorRealPaths: new Set() }];

  while (pendingDirectories.length > 0) {
    const pending = pendingDirectories.pop();
    if (pending === undefined) {
      break;
    }

    const canonicalDirectory = realpathSync(pending.directory);
    if (!isInsideRoot(canonicalRoot, canonicalDirectory)) {
      throw new Error(
        `Generated-code gate source directory resolves outside the repository: ${pending.directory}`,
      );
    }
    if (pending.ancestorRealPaths.has(canonicalDirectory)) {
      continue;
    }

    const descendantRealPaths = new Set(pending.ancestorRealPaths);
    descendantRealPaths.add(canonicalDirectory);

    for (const entry of readDirectory(pending.directory)) {
      if (skippedDirectories.has(entry.name)) {
        continue;
      }

      const entryPath = resolve(pending.directory, entry.name);
      if (entry.isDirectory()) {
        pendingDirectories.push({
          directory: entryPath,
          ancestorRealPaths: descendantRealPaths,
        });
      } else if (entry.isSymbolicLink()) {
        const canonicalEntry = realpathSync(entryPath);
        if (!isInsideRoot(canonicalRoot, canonicalEntry)) {
          throw new Error(
            `Generated-code gate source path resolves outside the repository: ${entryPath}`,
          );
        }
        if (resolvesThroughSkippedDirectory(canonicalRoot, canonicalEntry)) {
          continue;
        }

        const target = statSync(entryPath);
        if (target.isDirectory()) {
          pendingDirectories.push({
            directory: entryPath,
            ancestorRealPaths: descendantRealPaths,
          });
        } else if (
          target.isFile() &&
          sourceExtensionPattern.test(entry.name) &&
          entryPath !== thisTestFile
        ) {
          sourceFiles.push(entryPath);
        }
      } else if (
        entry.isFile() &&
        sourceExtensionPattern.test(entry.name) &&
        entryPath !== thisTestFile
      ) {
        sourceFiles.push(entryPath);
      }
    }
  }

  return sourceFiles.sort();
}

describe("generated-code safety gate static tripwire", () => {
  it("the generated-code gate remains CLOSED", () => {
    const gate = readFileSync(
      resolve(repoRoot, "docs/security/GENERATED_CODE_GATE.md"),
      "utf8",
    );

    expect(gate.split(/\r?\n/)).toContain("Status: CLOSED");
  });

  it("detects representative adversarial spellings of every forbidden sink", () => {
    const probes = [
      ["eval", "eval \n (source)"],
      ["eval", `globalThis["eval"] (source)`],
      ["Function constructor", "new \n Function (source)"],
      ["Function constructor", `globalThis["Function"] (source)`],
      ["dynamic import", "import \n (moduleName)"],
      ["child_process", `require("node:child_process")`],
      ["node:vm", `from "node:vm"`],
      ["worker_threads", `from "node:worker_threads"`],
      ["WebAssembly compile/instantiate", "WebAssembly . compile (bytes)"],
      [
        "WebAssembly compile/instantiate",
        "WebAssembly . instantiateStreaming (bytes)",
      ],
      ["Deno.Command", "new Deno . Command (program)"],
      ["Bun.spawn", "Bun . spawn (command)"],
      ["document.write", "document . write (markup)"],
      ["innerHTML", `element["innerHTML"] = markup`],
      ["dangerouslySetInnerHTML", "dangerouslySetInnerHTML = value"],
    ] as const;

    for (const [expected, source] of probes) {
      expect(findForbiddenPrimitives(source), source).toContain(expected);
    }

    for (const extension of [
      "js",
      "jsx",
      "cjs",
      "mjs",
      "ts",
      "tsx",
      "cts",
      "mts",
    ]) {
      expect(sourceExtensionPattern.test(`source.${extension}`)).toBe(true);
    }
  });

  it("does not descend into skipped dependency directories", () => {
    const fixtureRoot = mkdtempSync(resolve(tmpdir(), "dasher-gate-prune-"));
    const skippedRoot = resolve(fixtureRoot, "node_modules");
    mkdirSync(skippedRoot);
    writeFileSync(resolve(skippedRoot, "ignored.ts"), "eval(source)");
    const guardedReader: DirectoryReader = (directory) => {
      if (directory === skippedRoot) {
        throw new Error("skipped directory was traversed");
      }
      return readDirectoryEntries(directory);
    };

    try {
      expect(() =>
        firstPartySourceFiles(fixtureRoot, guardedReader),
      ).not.toThrow();
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("keeps internal symbolic-link source files in gate coverage", () => {
    const fixtureRoot = mkdtempSync(resolve(tmpdir(), "dasher-gate-symlink-"));
    const sourcePath = resolve(fixtureRoot, "source.ts");
    const linkPath = resolve(fixtureRoot, "linked.ts");
    writeFileSync(sourcePath, "export const safe = true;");
    symlinkSync(sourcePath, linkPath, "file");

    try {
      expect(firstPartySourceFiles(fixtureRoot)).toContain(linkPath);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("keeps internal symbolic-link directories in gate coverage", () => {
    const fixtureRoot = mkdtempSync(resolve(tmpdir(), "dasher-gate-symlink-"));
    const sourceRoot = resolve(fixtureRoot, "source");
    const linkRoot = resolve(fixtureRoot, "linked");
    mkdirSync(sourceRoot);
    writeFileSync(
      resolve(sourceRoot, "source.ts"),
      "export const safe = true;",
    );
    symlinkSync(sourceRoot, linkRoot, "dir");

    try {
      expect(firstPartySourceFiles(fixtureRoot)).toContain(
        resolve(linkRoot, "source.ts"),
      );
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("fails closed on symbolic-link source files outside the repository", () => {
    const fixtureRoot = mkdtempSync(resolve(tmpdir(), "dasher-gate-symlink-"));
    const externalRoot = mkdtempSync(
      resolve(tmpdir(), "dasher-gate-external-"),
    );
    const externalPath = resolve(externalRoot, "external.ts");
    writeFileSync(externalPath, "export const unsafeBoundary = true;");
    symlinkSync(externalPath, resolve(fixtureRoot, "external.ts"), "file");

    try {
      expect(() => firstPartySourceFiles(fixtureRoot)).toThrow(
        /outside the repository/,
      );
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
      rmSync(externalRoot, { recursive: true, force: true });
    }
  });

  it("terminates internal symbolic-link directory cycles", () => {
    const fixtureRoot = mkdtempSync(resolve(tmpdir(), "dasher-gate-cycle-"));
    const sourceRoot = resolve(fixtureRoot, "source");
    mkdirSync(sourceRoot);
    const sourcePath = resolve(sourceRoot, "source.ts");
    writeFileSync(sourcePath, "export const safe = true;");
    symlinkSync(fixtureRoot, resolve(sourceRoot, "cycle"), "dir");

    try {
      expect(firstPartySourceFiles(fixtureRoot)).toEqual([sourcePath]);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("finds no forbidden execution or injection sinks in first-party source", () => {
    const violations = firstPartySourceFiles().flatMap((filePath) =>
      findForbiddenPrimitives(readFileSync(filePath, "utf8")).map(
        (primitive) => `${filePath}: ${primitive}`,
      ),
    );

    expect(violations).toEqual([]);
  });
});
