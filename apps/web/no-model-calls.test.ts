// @vitest-environment node
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The README says "Model calls: disabled". This is what makes that a fact about
 * the repository rather than a note someone remembered to keep accurate.
 *
 * A real planning provider now exists — `@dasher/planner/anthropic` — and it is
 * deliberately reachable only from an eval script. Two things keep it out of the
 * product: it lives behind a package subpath that the app does not import, and
 * `@anthropic-ai/sdk` is a devDependency of `@dasher/planner` rather than a
 * dependency. Both are one careless import away from being untrue, and neither
 * announces itself when it stops holding.
 *
 * This is a text scan over the app's own source, with the same limits as any
 * text scan: a dynamic import built from a variable would be invisible. It
 * catches the realistic failure, which is somebody wiring the live provider into
 * a server action because it was easier than plumbing a feature flag.
 */

const webRoot = fileURLToPath(new URL(".", import.meta.url));
const skipped = new Set([
  "node_modules",
  ".next",
  "test-results",
  "playwright-report",
]);

async function sourceFiles(directory: string, found: string[] = []) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || skipped.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await sourceFiles(path, found);
    } else if (/\.tsx?$/u.test(entry.name)) {
      found.push(path);
    }
  }
  return found;
}

describe("the product cannot reach a model", () => {
  it("imports neither the live provider nor an HTTP model client", async () => {
    const files = await sourceFiles(webRoot);
    // Guard the guard: a scanner that found nothing would report a clean app
    // forever, and this file would be the only evidence anyone looked.
    expect(files.length).toBeGreaterThan(5);
    expect(files.some((file) => file.endsWith("actions.ts"))).toBe(true);

    const offenders: string[] = [];
    for (const file of files) {
      if (file === fileURLToPath(import.meta.url)) continue;
      const source = await readFile(file, "utf8");
      if (
        source.includes("@dasher/planner/anthropic") ||
        source.includes("@anthropic-ai/sdk")
      ) {
        offenders.push(file.slice(webRoot.length));
      }
    }

    expect(offenders).toStrictEqual([]);
  });

  it("constructs the deterministic planner in the server action", async () => {
    // The positive half. Asserting only the absence of the live provider would
    // still pass if the planner were removed altogether.
    const source = await readFile(join(webRoot, "app", "actions.ts"), "utf8");

    expect(source).toContain("FakePlanningProvider");
  });
});
