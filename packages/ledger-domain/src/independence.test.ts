// @vitest-environment node
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The ledger does not know what a station is.
 *
 * This is the claim the slice rests on, and "I did not import it" is the kind
 * of claim that stays true only until someone needs one convenient helper. The
 * manifest is where it is checkable.
 */

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

describe("@dasher/ledger-domain", () => {
  it("depends on the contract and nothing domain-specific", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("package.json", `file://${packageRoot}`), "utf8"),
    ) as { dependencies: Record<string, string> };

    // Pinned rather than filtered, so adding a dependency is a decision
    // someone sees. `@dasher/calculation-engine` joined the list when the
    // ledger's arithmetic moved onto it; it is domain-neutral by construction —
    // its own docstring says it has no database, network, clock, or provider,
    // and it knows nothing about stations or ledgers.
    expect(Object.keys(manifest.dependencies).sort()).toStrictEqual([
      "@dasher/calculation-engine",
      "@dasher/dashboard-schema",
      "zod",
    ]);
  });

  it("reaches no domain package, whichever one it is", async () => {
    // The list above says what is there; this says what may not be. A second
    // source domain arriving is exactly when someone would reach for one.
    const manifest = JSON.parse(
      await readFile(new URL("package.json", `file://${packageRoot}`), "utf8"),
    ) as { dependencies: Record<string, string> };

    expect(
      Object.keys(manifest.dependencies).filter((name) =>
        /^@dasher\/(?:station|river|air|enrollment)-domain$/u.test(name),
      ),
    ).toStrictEqual([]);
  });

  it("mentions no station vocabulary in its source", async () => {
    const source = await readFile(
      new URL("src/ledger.ts", `file://${packageRoot}`),
      "utf8",
    );
    // The docstring explains what a station is and why this is not one, so the
    // check is on code rather than prose: comments are stripped first.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//gu, "")
      .replace(/\/\/.*$/gmu, "");

    expect(code).not.toMatch(/siteId|latitude|longitude|gauge|Station/u);
  });
});
