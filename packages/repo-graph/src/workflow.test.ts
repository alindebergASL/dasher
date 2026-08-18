import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

/**
 * Every workflow parses, under a reader at least as strict as GitHub's.
 *
 * This exists because of a specific failure: a second `env:` key was added to a
 * job that already had one, GitHub rejected the file, and the run completed
 * with ZERO jobs. Not a red build — an empty one, which a commit sails past.
 *
 * It survived review because it was validated with a permissive parser.
 * `yaml.safe_load` accepts duplicate keys and keeps the last, so the check
 * reported "valid" about a file GitHub would not accept.
 *
 * The first fix here was a hand-written scanner, and it was unsound: it missed
 * a duplicate whose first occurrence sat on a sequence item (`- env:`), and it
 * could read lines inside a `run: |` block scalar as though they were mappings.
 * A checker that is wrong in both directions is worse than none, because it
 * makes people stop looking. This uses a real YAML parser and reports what it
 * reports.
 *
 * WHERE THIS RUNS MATTERS MORE THAN WHAT IT CHECKS. A test inside the suite
 * that `ci.yml` invokes cannot protect `ci.yml`: if the file will not schedule,
 * nothing in it executes, including this. `.github/workflows/workflow-lint.yml`
 * is a separate workflow whose only job is to validate the others, so one
 * broken file cannot switch off its own check. This test is the local half.
 */

const workflowDirectory = fileURLToPath(
  new URL("../../../.github/workflows/", import.meta.url),
);

const workflowFiles = ["ci.yml", "workflow-lint.yml"] as const;

describe("the workflow files", () => {
  it.each(workflowFiles)("%s parses with no duplicate keys", (name) => {
    const document = parseDocument(
      readFileSync(workflowDirectory + name, "utf8"),
      {
        // The whole point: GitHub rejects duplicate keys, so a reader that
        // tolerates them is not modelling the thing that matters.
        uniqueKeys: true,
      },
    );

    expect(document.errors.map((error) => error.message)).toEqual([]);
    expect(document.warnings.map((warning) => warning.message)).toEqual([]);
  });

  it("rejects the exact shape that broke it", () => {
    // A hollow check would accept the real files and this too.
    const broken = parseDocument(
      [
        "jobs:",
        "  verify:",
        "    env:",
        "      A: '1'",
        "    env:",
        "      B: '2'",
      ].join("\n"),
      { uniqueKeys: true },
    );

    expect(broken.errors.length).toBeGreaterThan(0);
  });

  it("rejects a duplicate whose first occurrence is on a sequence item", () => {
    // The case the hand-written scanner missed, which is why it was replaced.
    const broken = parseDocument(
      ["steps:", "  - env:", "      A: '1'", "    env:", "      B: '2'"].join(
        "\n",
      ),
      { uniqueKeys: true },
    );

    expect(broken.errors.length).toBeGreaterThan(0);
  });

  it("does not flag YAML-looking text inside a block scalar", () => {
    // The scanner's other failure: shell inside `run: |` is not a mapping, and
    // a checker that says otherwise gets switched off.
    const fine = parseDocument(
      [
        "steps:",
        "  - run: |",
        "      env: one",
        "      env: two",
        "  - run: echo done",
      ].join("\n"),
      { uniqueKeys: true },
    );

    expect(fine.errors).toEqual([]);
  });

  it("still defines the jobs the gates depend on", () => {
    const ci = parseDocument(
      readFileSync(workflowDirectory + "ci.yml", "utf8"),
    ).toJS() as { jobs: Record<string, unknown> };

    expect(Object.keys(ci.jobs).sort()).toEqual([
      "fast",
      "mutation",
      "persistence",
      "postgres",
      "verify",
    ]);
  });
});
