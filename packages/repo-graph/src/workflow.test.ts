import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The CI workflow parses under a strict reader.
 *
 * This exists because of a specific failure: a second `env:` key was added to a
 * job that already had one, GitHub rejected the file, and the whole run
 * completed with ZERO jobs — no unit tests, no build, no browser tests, nothing.
 * A workflow that does not parse does not fail loudly; it succeeds at running
 * nothing, and a commit sails past every gate it was supposed to clear.
 *
 * It also survived review because it was validated with a permissive parser.
 * `yaml.safe_load` and most YAML libraries accept duplicate keys and silently
 * keep the last one, so the check said "valid" about a file GitHub would not
 * accept. The lesson is narrower than "test the workflow": validate with a
 * reader at least as strict as the one that matters.
 */

const workflow = readFileSync(
  fileURLToPath(new URL("../../../.github/workflows/ci.yml", import.meta.url)),
  "utf8",
);

/**
 * Duplicate keys within one mapping block, found by indentation.
 *
 * Deliberately not a YAML parser — bringing one in to check that a YAML file
 * parses would only move the question to which parser. This reads the shape
 * that actually broke: two keys at the same indentation inside the same block.
 */
function duplicateKeys(source: string): string[] {
  const found: string[] = [];
  const seenByIndent = new Map<number, Set<string>>();
  let previousIndent = -1;

  for (const rawLine of source.split("\n")) {
    if (rawLine.trim() === "" || rawLine.trim().startsWith("#")) continue;

    const indent = rawLine.length - rawLine.trimStart().length;
    const match = /^([A-Za-z_][A-Za-z0-9_-]*):(\s|$)/u.exec(rawLine.trim());

    // Dedenting closes every deeper block, so their keys start fresh.
    if (indent < previousIndent) {
      for (const level of [...seenByIndent.keys()]) {
        if (level > indent) seenByIndent.delete(level);
      }
    }
    // A list item starts a new mapping at its own indentation.
    if (rawLine.trimStart().startsWith("- ")) {
      for (const level of [...seenByIndent.keys()]) {
        if (level >= indent) seenByIndent.delete(level);
      }
    }
    previousIndent = indent;
    if (match === null) continue;

    const key = match[1]!;
    const seen = seenByIndent.get(indent) ?? new Set<string>();
    if (seen.has(key)) found.push(`${key} (indent ${String(indent)})`);
    seen.add(key);
    seenByIndent.set(indent, seen);
  }
  return found;
}

describe("the CI workflow", () => {
  it("has no duplicate key in any mapping block", () => {
    expect(duplicateKeys(workflow)).toEqual([]);
  });

  it("catches the exact shape that broke it", () => {
    // A hollow check would pass the file and also pass this.
    const broken = [
      "jobs:",
      "  verify:",
      "    runs-on: ubuntu-latest",
      "    env:",
      "      A: '1'",
      "    env:",
      "      B: '2'",
    ].join("\n");

    expect(duplicateKeys(broken)).toContain("env (indent 4)");
  });

  it("does not flag the same key used in different blocks", () => {
    // `env:` legitimately appears in many jobs and steps. A check that could
    // not tell those apart would be turned off within a week.
    const fine = [
      "jobs:",
      "  one:",
      "    env:",
      "      A: '1'",
      "  two:",
      "    env:",
      "      B: '2'",
    ].join("\n");

    expect(duplicateKeys(fine)).toEqual([]);
  });

  it("still defines the jobs the gates depend on", () => {
    for (const job of [
      "  fast:",
      "  verify:",
      "  postgres:",
      "  persistence:",
      "  mutation:",
    ]) {
      expect(workflow).toContain(job);
    }
  });
});
