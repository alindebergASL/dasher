import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

interface Clause {
  label: string;
  pattern: RegExp;
}

function readDocument(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const readme = readDocument("../../../README.md");
const roadmap = readDocument(
  "../../../docs/roadmap/2026-07-30-private-pilot-roadmap.md",
);
const plan = readDocument(
  "../../../docs/plans/2026-07-30-executive-brief-gate.md",
);
const validation = readDocument(
  "../../../docs/validation/2026-07-30-executive-brief-gate.md",
);
const rehearsal = readDocument(
  "../../../docs/validation/2026-07-30-six-agent-executive-brief-rehearsal.md",
);

const modelIds = [
  "claude-fable-5",
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-haiku-4-5-20251001",
  "gpt-5.6-sol",
  "gpt-5.6-luna",
] as const;

function modelClauses(documentLabel: string): Clause[] {
  return modelIds.map((model) => ({
    label: `${documentLabel} model ${model}`,
    pattern: new RegExp("`" + model.replaceAll(".", "\\.") + "`"),
  }));
}

const readmeClauses: Clause[] = [
  {
    label: "README accepted synthetic links",
    pattern:
      /\[Executive Brief owner-accepted synthetic validation\]\(docs\/validation\/2026-07-30-executive-brief-gate\.md\)\s+- \[Six-agent Executive Brief rehearsal\]\(docs\/validation\/2026-07-30-six-agent-executive-brief-rehearsal\.md\)/,
  },
  {
    label: "README no human-equivalent claim",
    pattern:
      /No human sessions occurred, the agents are not\s+represented as human equivalents, and no 30-second human-usability claim is\s+made\./,
  },
  {
    label: "README later gates independent",
    pattern:
      /Later security, real-data, manager-user, and protected-release gates remain\s+independent\./,
  },
];

const roadmapClauses: Clause[] = [
  {
    label: "roadmap accepted synthetic status",
    pattern: /^Status: ACCEPTED — OWNER-ACCEPTED SYNTHETIC VALIDATION$/m,
  },
  {
    label: "roadmap no human-equivalent claim",
    pattern:
      /No human\s+sessions were conducted, no agent is represented as a human equivalent, and the\s+accepted result does not establish 30-second human comprehension or physical\s+interaction usability\./,
  },
  {
    label: "roadmap synthetic content 6/6",
    pattern:
      /- All 6 of 6 synthetic structured answers recovered the intended Known,\s+Changed, Important, and Next safe action content\./,
  },
  {
    label: "roadmap synthetic evidence 6/6 and replay",
    pattern:
      /- All 6 of 6 selected the requested evidence control and predicted no more than\s+two interactions; isolated Playwright replay opened every selected target in\s+one automated activation\./,
  },
  {
    label: "roadmap evidence integrity and freshness",
    pattern:
      /- Every visible factual or calculated claim resolves to valid evidence; stale\s+or missing data is not presented as fresh\./,
  },
  {
    label: "roadmap strict statement types 4/6",
    pattern:
      /- Exactly 4 of 6 reproduced the displayed source-fact, deterministic-\s+calculation, interpretation, and recommendation mapping without adding a\s+secondary type\./,
  },
  {
    label: "roadmap bounded feedback 6/6",
    pattern:
      /- All 6 of 6 supplied a bounded usefulness rating and one bounded missing-\s+information or workflow-need category\./,
  },
  {
    label: "roadmap explicit owner acceptance",
    pattern:
      /- The owner reviewed the dashboard and explicitly accepted the synthetic result\s+as the Gate 1 product decision\./,
  },
  {
    label: "roadmap Gate 4 retains real-user benchmark",
    pattern:
      /- On the file-generated dashboard, at least 5 of 6 manager-shaped users identify\s+Known, Changed, Important, and Next safe action within 30 seconds, and\s+independently at least 5 of 6 reach requested evidence within two interactions\./,
  },
  {
    label: "roadmap Gate 7 continues Gate 4 real-user goals",
    pattern:
      /- The Gate 4 real-user 30-second comprehension and two-interaction evidence\s+goals continue to pass on pilot dashboards\./,
  },
];

const planClauses: Clause[] = [
  {
    label: "plan accepted synthetic amendment",
    pattern:
      /## Post-implementation governance amendment\s+Status: ACCEPTED — OWNER-ACCEPTED SYNTHETIC VALIDATION/,
  },
  {
    label: "plan owner replaced real-person gate",
    pattern:
      /explicitly replaced the plan's previously required\s+six-real-person Gate 1 with an owner-accepted synthetic product gate\./,
  },
  {
    label: "plan no human-equivalent claim",
    pattern:
      /No human sessions were performed, no synthetic agent is\s+recorded as a human equivalent, and no 30-second human-comprehension claim is\s+made\./,
  },
  {
    label: "plan retained synthetic metrics",
    pattern:
      /6-of-6 content recovery, 6-of-6\s+predicted evidence reachability, 6-of-6 mechanically valid one-activation paths,\s+4-of-6 strict statement-type mapping, and bounded usefulness\/need feedback from\s+all six\./,
  },
  {
    label: "plan later gates remain independent",
    pattern:
      /Later roadmap gates retain their independent security, real-data,\s+manager-user, and release requirements\./,
  },
];

const validationClauses: Clause[] = [
  {
    label: "validation accepted synthetic status",
    pattern: /^Status: ACCEPTED — OWNER-ACCEPTED SYNTHETIC VALIDATION$/m,
  },
  {
    label: "validation explicit gate replacement",
    pattern:
      /replaced the previously planned six-real-person gate with the bounded\s+six-agent rehearsal recorded below\./,
  },
  {
    label: "validation no human-equivalent claim",
    pattern:
      /No real-human usability sessions were conducted\. The agents are not represented\s+as humans or human-equivalent research participants\./,
  },
  {
    label: "validation accepted exact candidate",
    pattern:
      /- Dashboard HEAD: `9a8ef6d2dd53156c46118d8d71154d780b0b9c04`\s+- Dashboard tree: `76c3e0fe825217479b8876dbb63fc61e0e34329b`/,
  },
  {
    label: "validation distinct isolated models",
    pattern:
      /- Isolation: six one-shot multimodal sessions with distinct model IDs, system\s+prompts, and manager\/community-leader personas\. Answers were not shared\./,
  },
  ...modelClauses("validation"),
  {
    label: "validation synthetic content 6/6",
    pattern:
      /- all six structured answers recovered the intended Known, Changed, Important,\s+and Next safe action content;/,
  },
  {
    label: "validation synthetic evidence and replay 6/6",
    pattern:
      /- all six selected the evidence control for the requested target and predicted\s+no more than two interactions;\s+- all six selected paths were mechanically verified to open the requested\s+evidence in one automated activation;/,
  },
  {
    label: "validation strict statement types 4/6",
    pattern:
      /- four of six reproduced the displayed statement-type mapping exactly;/,
  },
  {
    label: "validation all-six bounded feedback",
    pattern:
      /- all six supplied a bounded usefulness rating and one bounded need category;/,
  },
  {
    label: "validation owner decision",
    pattern:
      /Aggregate result: ACCEPTED — owner-accepted synthetic Gate 1\. No human sessions\s+were performed or counted, and no claim of human-equivalent validation is made\./,
  },
];

const rehearsalClauses: Clause[] = [
  {
    label: "rehearsal synthetic status",
    pattern: /^Status: ACCEPTED AS SYNTHETIC GATE EVIDENCE$/m,
  },
  {
    label: "rehearsal not human research",
    pattern:
      /This is a synthetic model rehearsal, not human research[\s\S]*must not be described\s+as human-equivalent validation\./,
  },
  ...modelClauses("rehearsal"),
  {
    label: "rehearsal honest provider diversity",
    pattern:
      /The six model IDs are distinct\. Provider diversity is not six-way: four are\s+Claude-family models and two are OpenAI Codex models\./,
  },
  {
    label: "rehearsal aggregate content 6/6",
    pattern: /\|\s*Four-part content recovered\s*\|\s*6\/6\s*\|\s*5\/6\s*\|/,
  },
  {
    label: "rehearsal aggregate evidence 6/6",
    pattern:
      /\|\s*Predicted evidence path within two interactions\s*\|\s*6\/6\s*\|\s*5\/6\s*\|/,
  },
  {
    label: "rehearsal aggregate strict types 4/6",
    pattern:
      /\|\s*Strict displayed statement-type mapping\s*\|\s*4\/6\s*\|\s*4\/6\s*\|/,
  },
  {
    label: "rehearsal aggregate mechanical 6/6",
    pattern:
      /\|\s*Chosen evidence path mechanically opened\s*\|\s*6\/6\s*\|\s*n\/a\s*\|/,
  },
  {
    label: "rehearsal aggregate bounded feedback 6/6",
    pattern:
      /\|\s*Bounded usefulness and need supplied\s*\|\s*6\/6\s*\|\s*6\/6\s*\|/,
  },
  {
    label: "rehearsal owner decision without human claim",
    pattern:
      /explicitly replaced\s+the previously planned real-person Gate 1 with this owner-accepted synthetic\s+product gate\. No agent was entered as a human participant, and no human usability\s+claim is made\./,
  },
];

function missingClauses(document: string, clauses: Clause[]): string[] {
  return clauses
    .filter(({ pattern }) => !pattern.test(document))
    .map(({ label }) => label);
}

describe("owner-accepted synthetic Gate 1 documentation contract", () => {
  it("locks the README summary without fabricating human validation", () => {
    expect(missingClauses(readme, readmeClauses)).toEqual([]);
  });

  it("locks the roadmap decision, synthetic evidence, and retained boundaries", () => {
    expect(missingClauses(roadmap, roadmapClauses)).toEqual([]);
  });

  it("locks the post-implementation governance amendment", () => {
    expect(missingClauses(plan, planClauses)).toEqual([]);
  });

  it("locks the accepted record without fabricating human validation", () => {
    expect(missingClauses(validation, validationClauses)).toEqual([]);
  });

  it("locks six distinct model records and aggregate rehearsal outcomes", () => {
    expect(missingClauses(rehearsal, rehearsalClauses)).toEqual([]);
  });

  it("rejects fabricated-human and weakened synthetic-evidence mutations", () => {
    const fabricatedReadmeHumans = readme.replace(
      "No human sessions occurred, the agents are not",
      "Six human-equivalent sessions occurred, and the agents are",
    );
    expect(missingClauses(fabricatedReadmeHumans, readmeClauses)).toContain(
      "README no human-equivalent claim",
    );

    const fabricatedHumans = validation.replace(
      "No real-human usability sessions were conducted. The agents are not represented",
      "Six human-equivalent usability sessions were conducted. The agents are represented",
    );
    expect(missingClauses(fabricatedHumans, validationClauses)).toContain(
      "validation no human-equivalent claim",
    );

    const weakenedRoadmap = roadmap
      .replace(
        "All 6 of 6 synthetic structured answers",
        "Only 5 of 6 synthetic structured answers",
      )
      .replace(
        "All 6 of 6 selected the requested evidence control",
        "Only 5 of 6 selected the requested evidence control",
      )
      .replace("Exactly 4 of 6 reproduced", "Exactly 3 of 6 reproduced")
      .replace("All 6 of 6 supplied", "Only 5 of 6 supplied");
    expect(missingClauses(weakenedRoadmap, roadmapClauses)).toEqual(
      expect.arrayContaining([
        "roadmap synthetic content 6/6",
        "roadmap synthetic evidence 6/6 and replay",
        "roadmap strict statement types 4/6",
        "roadmap bounded feedback 6/6",
      ]),
    );

    const missingEvidenceIntegrity = roadmap.replace(
      /- Every visible factual or calculated claim resolves to valid evidence; stale\s+  or missing data is not presented as fresh\.\n/,
      "",
    );
    expect(missingClauses(missingEvidenceIntegrity, roadmapClauses)).toContain(
      "roadmap evidence integrity and freshness",
    );

    const missingOwnerDecision = validation.replace(
      /Aggregate result: ACCEPTED — owner-accepted synthetic Gate 1\.[\s\S]*?Gate 2 engineering may begin subject to its own constraints and approvals\./,
      "Aggregate result: PENDING.",
    );
    expect(missingClauses(missingOwnerDecision, validationClauses)).toContain(
      "validation owner decision",
    );

    const missingPlanAmendment = plan.replace(
      "## Post-implementation governance amendment",
      "## Historical note",
    );
    expect(missingClauses(missingPlanAmendment, planClauses)).toContain(
      "plan accepted synthetic amendment",
    );

    const collapsedModelDiversity = rehearsal.replace(
      "`gpt-5.6-luna`",
      "`gpt-5.6-sol`",
    );
    expect(missingClauses(collapsedModelDiversity, rehearsalClauses)).toContain(
      "rehearsal model gpt-5.6-luna",
    );

    const overstatedProviderDiversity = rehearsal.replace(
      "Provider diversity is not six-way: four are",
      "Provider diversity is fully six-way: four are",
    );
    expect(
      missingClauses(overstatedProviderDiversity, rehearsalClauses),
    ).toContain("rehearsal honest provider diversity");
  });
});
