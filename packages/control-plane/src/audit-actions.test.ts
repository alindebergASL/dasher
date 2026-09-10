import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The audit vocabulary may only ever grow.
 *
 * `audit_events_action_check` is an allowlist, and PostgreSQL cannot extend a
 * CHECK in place, so every migration that adds an action restates the whole
 * list. That makes dropping one a silent, one-line mistake: 0006 was first
 * written by copying the list from the baseline, which lost `sign_in.requested`
 * — added by 0002 — and would have failed the next sign-in on a live
 * deployment against a constraint nobody had touched. The schema snapshot
 * caught it. This catches it without a database, at the file that caused it.
 *
 * A name is never removed here. Rows already carry it, so dropping it makes
 * stored history invalid and takes down whatever still writes it.
 */
const MIGRATIONS = path.resolve(process.cwd(), "migrations");
const CONSTRAINT = /ADD CONSTRAINT audit_events_action_check[\s\S]*?\);/gu;

function statedActions(sql: string): string[][] {
  return [...sql.matchAll(CONSTRAINT)].map((match) => [
    ...new Set(
      [...(match[0].match(/'([a-z_]+\.[a-z_]+)'/gu) ?? [])].map((quoted) =>
        quoted.slice(1, -1),
      ),
    ),
  ]);
}

describe("the audit action allowlist", () => {
  const files = readdirSync(MIGRATIONS)
    .filter((file) => file.endsWith(".sql"))
    .sort();

  it("has migrations to read", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("never drops an action a previous migration allowed", () => {
    let allowed: string[] = [];
    let last = "the baseline";
    const lost: string[] = [];

    for (const file of files) {
      const sql = readFileSync(path.join(MIGRATIONS, file), "utf8");
      for (const stated of statedActions(sql)) {
        for (const action of allowed) {
          if (!stated.includes(action)) {
            lost.push(`${file} drops "${action}", allowed since ${last}`);
          }
        }
        allowed = stated;
        last = file;
      }
    }

    expect(lost).toEqual([]);
  });

  it("ends with a list holding every action any migration introduced", () => {
    const introduced = new Set<string>();
    let final: string[] = [];
    for (const file of files) {
      for (const stated of statedActions(
        readFileSync(path.join(MIGRATIONS, file), "utf8"),
      )) {
        for (const action of stated) introduced.add(action);
        final = stated;
      }
    }
    expect([...introduced].sort()).toEqual([...final].sort());
    // The two that make this test worth having: one from a later migration
    // than the baseline, and the one added most recently.
    expect(final).toContain("sign_in.requested");
    expect(final).toContain("version_plan.recorded");
  });
});
