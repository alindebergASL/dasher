import { describe, expect, it } from "vitest";

import {
  checkRestore,
  formatRestoreCheck,
  type RestoreCheckResult,
} from "./restore-check";

/**
 * The reporting half. The queries themselves are exercised against a real
 * restored database — see `restore-check.integration.test.ts` — because a fake
 * that returns the numbers I choose would prove only that I can add up.
 *
 * What is worth pinning here is the sentence a person reads at 3am, and in
 * particular the one case where "every invariant held" is the wrong thing to
 * say plainly.
 */

function fakeClient(rows: readonly number[]) {
  let index = 0;
  return {
    query<R extends Record<string, unknown>>(): Promise<{ rows: R[] }> {
      const value = rows[index] ?? 0;
      index += 1;
      return Promise.resolve({
        rows: [{ n: String(value) } as unknown as R],
      });
    },
  };
}

/** Counts first, in declaration order, then the five checks. */
const HEALTHY = [3, 12, 40, 44, 7, 0, 0, 0, 0, 0];
const EMPTY = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

describe("checkRestore", () => {
  it("passes when nothing dangles", async () => {
    const result = await checkRestore(fakeClient(HEALTHY));
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.counts.snapshots).toBe(3);
    expect(result.counts.claimEdges).toBe(44);
  });

  it("reports every broken invariant, not just the first", async () => {
    // A restore that lost one table breaks several of these at once, and a
    // report that stopped at the first would understate the damage.
    const result = await checkRestore(
      fakeClient([3, 12, 40, 44, 7, 1, 2, 3, 4, 5]),
    );
    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(5);
    expect(result.failures.join("\n")).toContain("no longer hash");
    expect(result.failures.join("\n")).toContain("cite a stored file");
    expect(result.failures.join("\n")).toContain(
      "evidence record that is missing",
    );
    expect(result.failures.join("\n")).toContain("belong to a stored file");
    expect(result.failures.join("\n")).toContain("evidence is complete");
  });

  it("carries the scale of each failure, not just its kind", async () => {
    // "Some claims dangle" and "1,148 claims dangle" call for different
    // decisions at the moment somebody is deciding whether to keep this
    // restore.
    const result = await checkRestore(
      fakeClient([3, 12, 40, 44, 7, 0, 0, 35, 0, 0]),
    );
    expect(result.failures[0]).toContain("35 claim edge(s)");
  });
});

describe("formatRestoreCheck", () => {
  it("refuses to call an empty restore simply verified", async () => {
    // The worst outcome and the one most likely to look like success: every
    // invariant holds vacuously over no rows. A restore that brought nothing
    // must not read the same as one that brought everything.
    const result = await checkRestore(fakeClient(EMPTY));
    expect(result.ok).toBe(true);

    const text = formatRestoreCheck(result);
    expect(text).toContain("EMPTY");
    expect(text).toContain("did not bring it");
  });

  it("says what it verified, with the totals", async () => {
    const text = formatRestoreCheck(await checkRestore(fakeClient(HEALTHY)));
    expect(text).toContain("Restore verified");
    expect(text).toContain("3 stored file(s)");
    expect(text).toContain("44 edge(s)");
    expect(text).not.toContain("EMPTY");
  });

  it("leads with the failure rather than the tally", async () => {
    const result: RestoreCheckResult = {
      ok: false,
      counts: {
        snapshots: 3,
        evidenceRecords: 12,
        claims: 40,
        claimEdges: 44,
        dashboardVersions: 7,
      },
      failures: ["2 dashboard version(s) cite a stored file that is missing"],
    };
    expect(formatRestoreCheck(result).startsWith("RESTORE NOT VERIFIED")).toBe(
      true,
    );
  });
});
