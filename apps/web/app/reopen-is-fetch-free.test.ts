// @vitest-environment node
import { readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Reopening a saved dashboard must not touch an upstream source.
 *
 * This is the slice's persistence promise stated as a property of the code
 * rather than of one run: `/d/[id]` renders the bytes `finalize_run` sealed, so
 * nothing on that path may reach `source-runtime.ts` — the only module in this
 * app that talks to USGS or OpenAQ. A run-time spy on `fetch` would prove that
 * ONE request did not fetch, and would keep passing if a later change made the
 * fetch conditional on a cache miss. Reachability is the stronger claim: there
 * is no input for which reopening can fetch, because the code that fetches is
 * not in the graph.
 *
 * Both directions matter, and the second is the one that keeps this honest. A
 * walker that silently resolved nothing would report every route clean forever,
 * so the same walk is run from a page that DOES plan — and is required to find
 * the source runtime there. If that expectation ever fails, this file is broken
 * rather than the app being safe.
 */

const appRoot = fileURLToPath(new URL(".", import.meta.url));
const webRoot = resolve(appRoot, "..");
const SOURCE_RUNTIME = resolve(appRoot, "source-runtime.ts");

/** `import`/`export ... from "..."` specifiers, static forms only. */
const SPECIFIER =
  /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*["']([^"']+)["']/gu;

const CANDIDATE_SUFFIXES = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];

async function resolveLocal(
  specifier: string,
  fromFile: string,
): Promise<string | undefined> {
  // Only first-party modules are followed. A package boundary is a different
  // question, already answered for `server-only` by the runtime itself.
  const base = specifier.startsWith("@/")
    ? resolve(webRoot, specifier.slice(2))
    : specifier.startsWith(".")
      ? resolve(dirname(fromFile), specifier)
      : undefined;
  if (base === undefined) return undefined;

  for (const suffix of CANDIDATE_SUFFIXES) {
    const candidate = `${base}${suffix}`;
    try {
      await readFile(candidate, "utf8");
      return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

/** Every first-party module reachable from `entry`, including `entry`. */
async function reachableFrom(entry: string): Promise<Set<string>> {
  const seen = new Set<string>();
  const pending = [entry];

  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);

    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(SPECIFIER)) {
      const specifier = match[1];
      if (specifier === undefined) continue;
      const resolved = await resolveLocal(specifier, file);
      if (resolved !== undefined && !seen.has(resolved)) pending.push(resolved);
    }
  }

  return seen;
}

const shortPath = (file: string) => relative(webRoot, file);

describe("reopening a saved dashboard cannot reach an upstream source", () => {
  it("finds the source runtime from the page that plans", async () => {
    // GUARD THE GUARD, FIRST. Everything below is an absence, and an absence
    // proves nothing until the search is shown to work. `/` plans on request,
    // so the source runtime must be reachable from it.
    const planning = await reachableFrom(resolve(appRoot, "page.tsx"));

    expect(planning.size).toBeGreaterThan(3);
    expect([...planning].map(shortPath)).toContain("app/source-runtime.ts");
  });

  it("does not find it from the saved-dashboard route", async () => {
    const reopen = await reachableFrom(resolve(appRoot, "d/[id]/page.tsx"));

    // The route itself, the contract it re-parses, and the shell it renders.
    expect([...reopen].map(shortPath)).toContain("app/d/[id]/page.tsx");
    expect([...reopen].map(shortPath)).toContain(
      "components/dashboard-shell.tsx",
    );
    expect(reopen.has(SOURCE_RUNTIME)).toBe(false);
  });

  it("does not find it from the listing either", async () => {
    // The other way back to a saved dashboard. Browsing a list of titles has
    // even less business contacting a gauge than reopening one does.
    const listing = await reachableFrom(
      resolve(appRoot, "dashboards/page.tsx"),
    );

    expect([...listing].map(shortPath)).toContain("app/dashboards/page.tsx");
    expect(listing.has(SOURCE_RUNTIME)).toBe(false);
  });
});
