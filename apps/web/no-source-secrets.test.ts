// @vitest-environment node
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The credential never reaches the browser, and neither does the code that
 * uses it.
 *
 * `server-only` makes Next fail a build that pulls the source runtime into a
 * client bundle, which is the real enforcement — but a guarantee whose only
 * evidence is "the build would have failed" is one nobody can see. This scans
 * the built client output for both the runtime's fingerprints and anything
 * shaped like the key.
 *
 * It is skipped when `.next` has not been built, and that is a real limit
 * rather than a convenience: `pnpm build` runs before e2e in CI, so the gate
 * is armed where it matters. Stated plainly so nobody reads a skip as a pass.
 */

const webRoot = fileURLToPath(new URL(".", import.meta.url));
const clientChunks = join(webRoot, ".next", "static");

async function builtFiles(directory: string, found: string[] = []) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await builtFiles(path, found);
    else if (/\.(?:js|mjs|json|css)$/u.test(entry.name)) found.push(path);
  }
  return found;
}

async function built(): Promise<boolean> {
  try {
    await stat(clientChunks);
    return true;
  } catch {
    return false;
  }
}

describe("the client bundle", () => {
  it("contains no OpenAQ credential and no upstream host", async () => {
    if (!(await built())) {
      // Not silent: an unbuilt tree cannot answer this question.
      console.warn("no .next/static; run `pnpm build` to arm this gate");
      return;
    }

    const files = await builtFiles(clientChunks);
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      if (
        source.includes("OPENAQ_API_KEY") ||
        source.includes("X-API-Key") ||
        source.includes("api.openaq.org") ||
        source.includes("waterservices.usgs.gov")
      ) {
        offenders.push(file.slice(clientChunks.length));
      }
    }

    expect(offenders).toStrictEqual([]);
  });

  it("keeps the source runtime out of every client component", async () => {
    // The import-side half, which does not need a build: a `"use client"`
    // module reaching the runtime would break the build, and this says so
    // before the build does.
    const files: string[] = [];
    const walk = async (directory: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (
          entry.name === "node_modules" ||
          entry.name === ".next" ||
          entry.name === "test-results" ||
          entry.name === "playwright-report"
        ) {
          continue;
        }
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (/\.(?:ts|tsx)$/u.test(entry.name)) files.push(path);
      }
    };
    await walk(webRoot);

    expect(files.length).toBeGreaterThan(5);
    const offenders: string[] = [];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      const isClient = /^\s*["']use client["']/u.test(source);
      if (isClient && source.includes("source-runtime")) {
        offenders.push(file.slice(webRoot.length));
      }
    }

    expect(offenders).toStrictEqual([]);
  });

  it("keeps the read paths off the network entirely", async () => {
    // Reopening a saved dashboard renders sealed stored bytes, and the
    // listing reads rows. Neither may contact a source: a permalink that
    // re-fetched would make an archived dashboard silently change, and a
    // listing that fetched would put an upstream on the critical path of a
    // page that shows no readings at all.
    const readPaths = [
      join(webRoot, "app", "d", "[id]", "page.tsx"),
      join(webRoot, "app", "dashboards", "page.tsx"),
      join(webRoot, "app", "page.tsx"),
    ];

    for (const path of readPaths) {
      const source = await readFile(path, "utf8");
      expect(source).not.toContain("source-runtime");
      expect(source).not.toContain("loadDomainSnapshot");
    }
  });
});
