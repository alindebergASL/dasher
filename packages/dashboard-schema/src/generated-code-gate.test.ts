/// <reference types="node" />

import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
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

function firstPartySourceFiles(): string[] {
  return readdirSync(repoRoot, {
    encoding: "utf8",
    recursive: true,
  })
    .filter((relativePath) => {
      const segments = relativePath.split(/[\\/]/);
      return (
        !segments.some((segment) => skippedDirectories.has(segment)) &&
        sourceExtensionPattern.test(relativePath)
      );
    })
    .map((relativePath) => resolve(repoRoot, relativePath))
    .filter((filePath) => filePath !== thisTestFile);
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

  it("finds no forbidden execution or injection sinks in first-party source", () => {
    const violations = firstPartySourceFiles().flatMap((filePath) =>
      findForbiddenPrimitives(readFileSync(filePath, "utf8")).map(
        (primitive) => `${filePath}: ${primitive}`,
      ),
    );

    expect(violations).toEqual([]);
  });
});
