import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

interface Clause {
  label: string;
  pattern: RegExp;
}

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

const roadmapClauses: Clause[] = [
  {
    label: "roadmap comprehension 5/6",
    pattern:
      /- At least 5 of 6 manager-shaped participants identify all four brief elements\s+within 30 seconds, uncoached\./,
  },
  {
    label: "roadmap evidence 5/6",
    pattern:
      /- At least 5 of 6 reach evidence for a selected material claim within two\s+interactions\./,
  },
  {
    label: "roadmap evidence integrity and freshness",
    pattern:
      /- Every visible factual or calculated claim resolves to valid evidence; stale\s+or missing data is not presented as fresh\./,
  },
  {
    label: "roadmap statement types 4/6",
    pattern:
      /- At least 4 of 6 distinguish source facts, deterministic calculations, model\s+interpretation, and recommendations\./,
  },
  {
    label: "roadmap all-six feedback",
    pattern:
      /- Every participant supplies a usefulness rating and one concrete missing\s+information or workflow need\./,
  },
];

const planClauses: Clause[] = [
  {
    label: "plan pending status",
    pattern: /Mark the record `Status: PENDING TARGET-ROLE VALIDATION`\./,
  },
  {
    label: "plan human-only participants",
    pattern:
      /Models and agents may provide QA feedback but cannot count as participants\./,
  },
  {
    label: "plan independent session outcomes",
    pattern:
      /Define two independent outcomes per session: comprehension passes when all four decision outcomes are correct without coaching within 30 seconds; evidence passes when the requested evidence opens within two counted interactions\./,
  },
  {
    label: "plan independent aggregate 5/6",
    pattern:
      /Define aggregate pass: at least five of six comprehension outcomes pass, independently at least five of six evidence outcomes pass,/,
  },
  {
    label: "plan statement types 4/6",
    pattern: /at least four distinguish statement types/,
  },
  {
    label: "plan all-six feedback",
    pattern: /every participant supplies usefulness and need fields/,
  },
  {
    label: "plan separate record outcomes",
    pattern: /separate comprehension\/evidence pass booleans/,
  },
];

const validationClauses: Clause[] = [
  {
    label: "validation pending status",
    pattern: /^Status: PENDING TARGET-ROLE VALIDATION$/m,
  },
  {
    label: "validation independent outcome definitions",
    pattern:
      /The comprehension outcome passes when all four decision outcomes are correct\s+without coaching within 30 seconds\.\s+Independently, the evidence outcome passes when the requested target's evidence\s+opens within no more than two counted interactions\./,
  },
  {
    label: "validation comprehension 5/6",
    pattern: /- at least five of six comprehension outcomes pass;/,
  },
  {
    label: "validation independently evidence 5/6",
    pattern: /- independently, at least five of six evidence outcomes pass;/,
  },
  {
    label: "validation statement types 4/6",
    pattern:
      /- at least four of six distinguish observed source facts, deterministic\s+calculations, interpretations, and recommendations; and/,
  },
  {
    label: "validation all-six feedback",
    pattern:
      /- all six supply a bounded usefulness rating and one bounded missing-information\s+or workflow-need category\./,
  },
  {
    label: "validation human-only decision",
    pattern:
      /No model, agent, or automated result decides the roadmap consequence\./,
  },
  {
    label: "validation automation cannot count toward six",
    pattern:
      /Automated tests, browser\s+checks, agents, and model reviews are engineering evidence only and do not count\s+toward the six target-role sessions\./,
  },
  {
    label: "validation real target-role non-builder profile",
    pattern:
      /Recruit exactly six real managers or community leaders who did not build the\s+dashboard\. A participant must approach the dashboard as a new decision-support\s+view rather than as an implementer or coached reviewer\./,
  },
  {
    label: "validation separate stored outcomes",
    pattern: /- separate comprehension-pass and evidence-pass booleans; and/,
  },
  {
    label: "validation separate record columns",
    pattern: /\| Comprehension pass \| Evidence pass \|/,
  },
  {
    label: "validation zero-session pending result",
    pattern:
      /Aggregate result: PENDING — 0 of 6 sessions completed; Gate 1 is not claimed\./,
  },
];

function missingClauses(document: string, clauses: Clause[]): string[] {
  return clauses
    .filter(({ pattern }) => !pattern.test(document))
    .map(({ label }) => label);
}

describe("Gate 1 documentation contract", () => {
  it("locks every governing roadmap threshold independently", () => {
    expect(missingClauses(roadmap, roadmapClauses)).toEqual([]);
  });

  it("locks plan independence, retained thresholds, records, and human-only status", () => {
    expect(missingClauses(plan, planClauses)).toEqual([]);
  });

  it("locks validation independence, retained thresholds, records, and pending status", () => {
    expect(missingClauses(validation, validationClauses)).toEqual([]);
  });

  it("rejects joint-threshold and weakened-threshold mutations", () => {
    const regressedPlan = plan
      .replace(
        "at least five of six comprehension outcomes pass, independently at least five of six evidence outcomes pass",
        "the same five sessions pass both comprehension and evidence",
      )
      .replace(
        "at least four distinguish statement types",
        "at least three distinguish statement types",
      )
      .replace(
        "every participant supplies usefulness and need fields",
        "five participants supply usefulness and need fields",
      );
    expect(missingClauses(regressedPlan, planClauses)).toEqual(
      expect.arrayContaining([
        "plan independent aggregate 5/6",
        "plan statement types 4/6",
        "plan all-six feedback",
      ]),
    );

    const regressedValidation = validation
      .replace(
        "- independently, at least five of six evidence outcomes pass;",
        "- the same five sessions must pass both outcomes;",
      )
      .replace(
        "- at least four of six distinguish",
        "- at least three of six distinguish",
      )
      .replace("- all six supply", "- five of six supply");
    expect(missingClauses(regressedValidation, validationClauses)).toEqual(
      expect.arrayContaining([
        "validation independently evidence 5/6",
        "validation statement types 4/6",
        "validation all-six feedback",
      ]),
    );

    const missingRoadmapEvidenceIntegrity = roadmap.replace(
      /- Every visible factual or calculated claim resolves to valid evidence; stale\s+  or missing data is not presented as fresh\.\n/,
      "",
    );
    expect(
      missingClauses(missingRoadmapEvidenceIntegrity, roadmapClauses),
    ).toContain("roadmap evidence integrity and freshness");

    const automationCountedAsHuman = validation.replace(
      "engineering evidence only and do not count",
      "engineering evidence and may count",
    );
    expect(
      missingClauses(automationCountedAsHuman, validationClauses),
    ).toContain("validation automation cannot count toward six");

    const coachedImplementersCounted = validation.replace(
      /Recruit exactly six real managers or community leaders who did not build the\ndashboard\. A participant must approach the dashboard as a new decision-support\nview rather than as an implementer or coached reviewer\./,
      "Recruit any six people, including coached implementers who built the dashboard.",
    );
    expect(
      missingClauses(coachedImplementersCounted, validationClauses),
    ).toContain("validation real target-role non-builder profile");
  });
});
