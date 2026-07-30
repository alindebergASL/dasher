import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const roadmap = readFileSync(
  new URL(
    "../../../docs/roadmap/2026-07-30-private-pilot-roadmap.md",
    import.meta.url,
  ),
  "utf8",
);
const plan = readFileSync(
  new URL(
    "../../../docs/plans/2026-07-30-executive-brief-gate.md",
    import.meta.url,
  ),
  "utf8",
);
const validation = readFileSync(
  new URL(
    "../../../docs/validation/2026-07-30-executive-brief-gate.md",
    import.meta.url,
  ),
  "utf8",
);

describe("Gate 1 documentation contract", () => {
  it("keeps comprehension and evidence as independent five-of-six thresholds", () => {
    expect(roadmap).toMatch(
      /At least 5 of 6[\s\S]*identify all four brief elements[\s\S]*At least 5 of 6[\s\S]*reach evidence/,
    );

    expect(plan).toMatch(
      /aggregate pass:[\s\S]*five of six comprehension outcomes[\s\S]*five of six evidence outcomes/i,
    );

    expect(validation).toMatch(
      /at least five of six comprehension outcomes pass[\s\S]*at least five of six evidence outcomes pass/i,
    );
    expect(validation).toContain("Comprehension pass");
    expect(validation).toContain("Evidence pass");
    expect(validation).not.toMatch(
      /sessions pass the comprehension and\s+evidence task/i,
    );
  });
});
