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

interface RoadmapGateBoundary {
  key: string;
  text: string;
}

const expectedRoadmapGateBoundaries = JSON.parse(
  readDocument("./private-pilot-gate-boundaries.json"),
) as RoadmapGateBoundary[];

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function replaceOccurrence(
  source: string,
  search: string,
  occurrence: number,
  replacement: string,
): string {
  let from = 0;
  let found = -1;
  for (let index = 0; index < occurrence; index += 1) {
    found = source.indexOf(search, from);
    if (found < 0)
      throw new Error(`missing occurrence ${occurrence}: ${search}`);
    from = found + search.length;
  }
  return `${source.slice(0, found)}${replacement}${source.slice(found + search.length)}`;
}

function parseRoadmapGateBoundaries(document: string): RoadmapGateBoundary[] {
  const boundaries: RoadmapGateBoundary[] = [];
  const counts = new Map<string, number>();
  let gate: string | null = null;
  let current: string[] = [];

  const flush = () => {
    if (gate && current.length > 0) {
      const text = normalizeWhitespace(current.join(" "));
      if (text.length > 0) {
        const count = (counts.get(gate) ?? 0) + 1;
        counts.set(gate, count);
        boundaries.push({
          key: `${gate}-${String(count).padStart(2, "0")}`,
          text,
        });
      }
    }
    current = [];
  };

  for (const line of document.split("\n")) {
    const gateHeading = line.match(/^## Gate ([2-7]) — .+$/);
    if (gateHeading?.[1]) {
      flush();
      gate = `gate${gateHeading[1]}`;
      current = [line.slice(3)];
      flush();
      continue;
    }
    if (gate && line.startsWith("## ")) {
      flush();
      gate = null;
      continue;
    }
    if (!gate) continue;
    if (line.startsWith("### ")) {
      flush();
      current = [line];
      flush();
      continue;
    }
    if (line.trim().length === 0) {
      flush();
      continue;
    }
    if (line.startsWith("- ")) {
      flush();
      current = [line];
      continue;
    }
    current.push(line);
  }
  flush();
  return boundaries;
}

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
      /No human sessions occurred, the agents are not represented as\s+human equivalents, and no 30-second human-usability claim is made\./,
  },
  {
    label: "README honest provider diversity",
    pattern:
      /The six model IDs are distinct, but provider\s+diversity is not six-way: four are Claude-family models and two are OpenAI models\s+run through Codex\./,
  },
  {
    label: "README later gates independent",
    pattern:
      /Later\s+security, real-data, manager-user, and protected-release gates remain independent\./,
  },
];

const expectedValidationAgentRows = [
  [
    "A01",
    "County emergency-management director",
    "`claude-fable-5`",
    "changed",
    "PASS",
    "2",
    "1",
    "MISS",
    "4",
    "missing-context",
    "More historical comparison",
  ],
  [
    "A02",
    "Regional water-utility operations manager",
    "`claude-opus-5`",
    "next-action",
    "PASS",
    "2",
    "1",
    "MISS",
    "4",
    "unclear, missing-context",
    "Clearer alert thresholds",
  ],
  [
    "A03",
    "City manager and executive generalist",
    "`claude-sonnet-5`",
    "changed",
    "PASS",
    "2",
    "1",
    "PASS",
    "4",
    "missing-context",
    "Named owner or handoff",
  ],
  [
    "A04",
    "Watershed nonprofit executive director",
    "`claude-haiku-4-5-20251001`",
    "next-action",
    "PASS",
    "2",
    "1",
    "PASS",
    "4",
    "missing-context",
    "Named owner or handoff",
  ],
  [
    "A05",
    "Private-company COO",
    "`gpt-5.6-sol`",
    "changed",
    "PASS",
    "1",
    "1",
    "PASS",
    "4",
    "missing-context",
    "Named owner or handoff",
  ],
  [
    "A06",
    "Elected county supervisor",
    "`gpt-5.6-luna`",
    "next-action",
    "PASS",
    "1",
    "1",
    "PASS",
    "4",
    "missing-context",
    "Named owner or handoff",
  ],
] as const;

const expectedRehearsalAgentRows = expectedValidationAgentRows;

function parseAgentRows(document: string): string[][] {
  return document
    .split("\n")
    .filter((line) => /^\|\s*A\d+\s*\|/.test(line))
    .map((line) =>
      line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim()),
    );
}

const allowedFeedbackFlags = new Set([
  "wrong",
  "unclear",
  "missing-context",
  "none",
]);

function deriveAgentResults(rows: string[][]) {
  const total = rows.length;
  const usefulnessScore = Number(rows[0]?.[8]);
  return {
    content: [rows.filter((row) => row[4] === "PASS").length, total] as [
      number,
      number,
    ],
    evidence: [rows.filter((row) => Number(row[5]) <= 2).length, total] as [
      number,
      number,
    ],
    mechanical: [rows.filter((row) => row[6] === "1").length, total] as [
      number,
      number,
    ],
    strictTypes: [rows.filter((row) => row[7] === "PASS").length, total] as [
      number,
      number,
    ],
    boundedFeedback: [
      rows.filter(
        (row) =>
          Number(row[8]) >= 1 &&
          Number(row[8]) <= 5 &&
          (row[9] ?? "")
            .split(",")
            .map((flag) => flag.trim())
            .every((flag) => allowedFeedbackFlags.has(flag)) &&
          row[10] !== undefined &&
          row[10].length > 0,
      ).length,
      total,
    ] as [number, number],
    namedOwnerNeed: [
      rows.filter((row) => row[10] === "Named owner or handoff").length,
      total,
    ] as [number, number],
    usefulnessScore: [usefulnessScore, 5] as [number, number],
    distinctModels: new Set(rows.map((row) => row[2])).size,
    changedTargets: rows.filter((row) => row[3] === "changed").length,
    nextActionTargets: rows.filter((row) => row[3] === "next-action").length,
    allowedFeedback: rows.every(
      (row) =>
        Number(row[8]) === usefulnessScore &&
        (row[9] ?? "")
          .split(",")
          .map((flag) => flag.trim())
          .every((flag) => allowedFeedbackFlags.has(flag)),
    ),
  };
}

function mutateAgentCell(
  document: string,
  id: string,
  columnIndex: number,
  replacement: string,
): string {
  let changed = false;
  const result = document
    .split("\n")
    .map((line) => {
      if (!new RegExp(`^\\|\\s*${id}\\s*\\|`).test(line)) return line;
      const cells = line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim());
      cells[columnIndex] = replacement;
      changed = true;
      return `| ${cells.join(" | ")} |`;
    })
    .join("\n");
  if (!changed) throw new Error(`missing agent row ${id}`);
  return result;
}

function parseBoldAggregate(document: string, label: string): [number, number] {
  const line = document
    .split("\n")
    .find((candidate) => candidate.startsWith(`- ${label}: **`));
  const match = line?.match(/\*\*(\d+) of (\d+)\*\*/);
  if (!match?.[1] || !match[2]) throw new Error(`missing aggregate ${label}`);
  return [Number(match[1]), Number(match[2])];
}

function parseFraction(value: string, label: string): [number, number] {
  const match = value.match(/^(\d+)\/(\d+)$/);
  if (!match?.[1] || !match[2]) throw new Error(`missing fraction ${label}`);
  return [Number(match[1]), Number(match[2])];
}

function parseTableMeasure(document: string, label: string) {
  const line = document
    .split("\n")
    .find((candidate) => candidate.startsWith(`| ${label}`));
  const cells = line
    ?.split("|")
    .slice(1, -1)
    .map((cell) => cell.trim());
  const result = cells?.[1];
  const threshold = cells?.[2];
  if (!result || !threshold) throw new Error(`missing table measure ${label}`);
  return {
    result: parseFraction(result, `${label} result`),
    threshold:
      threshold === "n/a"
        ? null
        : parseFraction(threshold, `${label} threshold`),
  };
}

function parseTableAggregate(
  document: string,
  label: string,
): [number, number] {
  return parseTableMeasure(document, label).result;
}

function parseRehearsalThresholdNarrative(
  document: string,
): Map<string, [number, number] | null> {
  const match = document.match(
    /owner-approved synthetic thresholds are (\d+)\/(\d+) for four-part content, (\d+)\/(\d+) for\s+predicted evidence reachability, (\d+)\/(\d+) for mechanical replay, (\d+)\/(\d+) for strict\s+displayed types, and (\d+)\/(\d+) for bounded usefulness and need/,
  );
  if (!match || match.slice(1).some((value) => value === undefined)) {
    throw new Error("missing rehearsal threshold narrative");
  }
  return new Map<string, [number, number] | null>([
    ["Four-part content recovered", [Number(match[1]), Number(match[2])]],
    [
      "Predicted evidence path within two interactions",
      [Number(match[3]), Number(match[4])],
    ],
    [
      "Chosen evidence path mechanically opened",
      [Number(match[5]), Number(match[6])],
    ],
    [
      "Strict displayed statement-type mapping",
      [Number(match[7]), Number(match[8])],
    ],
    [
      "Bounded usefulness and need supplied",
      [Number(match[9]), Number(match[10])],
    ],
  ]);
}

function parseRatio(
  document: string,
  pattern: RegExp,
  label: string,
): [number, number] {
  const match = document.match(pattern);
  if (!match?.[1] || !match[2]) throw new Error(`missing ratio ${label}`);
  return [Number(match[1]), Number(match[2])];
}

function parseStimulusHashes(document: string): [string, string] {
  const head = document.match(
    /(?:Rehearsal stimulus HEAD:|dashboard HEAD)\s*`([a-f0-9]{40})`/,
  )?.[1];
  const tree = document.match(
    /(?:Rehearsal stimulus tree:|, tree)\s*`([a-f0-9]{40})`/,
  )?.[1];
  if (!head || !tree) throw new Error("missing rehearsal stimulus hashes");
  return [head, tree];
}

function extractSection(
  document: string,
  startHeading: string,
  endHeading: string,
): string {
  const start = document.indexOf(startHeading);
  const end = document.indexOf(endHeading, start + startHeading.length);
  if (start < 0 || end < 0) throw new Error(`missing section ${startHeading}`);
  return document.slice(start, end);
}

const humanResultSubject =
  /\b(?:human(?: participants?| sessions?| users?)|humans?|human-equivalent(?: participants?| sessions?| users?)?|real[- ](?:person|human|user)s?|participants?|manager-shaped users?)\b/i;
const positiveHumanResult =
  /\b(?:pass(?:ed|es)?|validat(?:e|ed|es|ion)|prov(?:e|ed|en)|succeed(?:ed|s)?|complet(?:ed|es)|met|achiev(?:e|ed|es)|conduct(?:ed|s)?|test(?:ed|s)?|interview(?:ed|s)?|enroll(?:ed|s)?|includ(?:ed|es)?|participat(?:ed|es)?|occur(?:red|s)?|happen(?:ed|s)?|perform(?:ed|s)?|count(?:ed|s)?)\b/i;

function hasSubjectScopedNegation(claim: string): boolean {
  const subject = humanResultSubject.exec(claim);
  if (!subject || subject.index === undefined) return false;
  const before = claim.slice(Math.max(0, subject.index - 80), subject.index);
  const after = claim.slice(
    subject.index + subject[0].length,
    subject.index + 100,
  );
  const negationBefore =
    /(?:\bno|\bzero|\bnot one|\bnone(?: of the)?)\s+(?:[\w-]+\s+){0,4}$/i.test(
      before,
    ) ||
    /\b(?:do|does|did|can|must|is|are|was|were)\s+not\s+(?:[\w-]+\s+){0,8}$/i.test(
      before,
    );
  const negationAfter =
    /^\s+(?:(?:did|does|do|was|were|is|are|has|have|had|must|can)\s+not|never|cannot)\b/i.test(
      after,
    );
  const laterPositiveResult = /\b(?:and|but|however|yet)\b/i.test(after)
    ? positiveHumanResult.test(
        after.slice(after.search(/\b(?:and|but|however|yet)\b/i)),
      )
    : false;
  return negationBefore || (negationAfter && !laterPositiveResult);
}

function findFabricatedHumanClaims(document: string): string[] {
  return document
    .replace(/`[^`]*`/g, "")
    .replace(/\n+/g, " ")
    .split(
      /(?<=[.!?;])\s+|,\s*(?:and|but|however|yet)\s+|\s+(?:but|however|yet)\s+/i,
    )
    .map((claim) => claim.trim())
    .filter(
      (claim) =>
        ((humanResultSubject.test(claim) && positiveHumanResult.test(claim)) ||
          /\bresults?\s+(?:are|were)\s+human-equivalent\b/i.test(claim)) &&
        !hasSubjectScopedNegation(claim),
    );
}

const syntheticClaimDocuments = [
  readme,
  extractSection(roadmap, "## Gate 1", "## Gate 2"),
  extractSection(
    plan,
    "## Post-implementation governance amendment",
    "## Hard boundaries",
  ),
  validation,
  rehearsal,
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
  {
    label: "roadmap Gate 2 forced tenant isolation",
    pattern:
      /Implement ADR-003 before accepting any real customer data: invitations,\s+sessions, organizations, roles, PostgreSQL `FORCE ROW LEVEL SECURITY`,\s+composite tenant-safe foreign keys, immutable sources\/evidence\/dashboard\s+versions\/job events\/audit, tenant-scoped object storage, revocation, limits,\s+backup\/restore, kill switches, and incident controls\./,
  },
  {
    label: "roadmap Gate 2 cross-tenant denial and fail-closed context",
    pattern:
      /- Cross-tenant read, count, update, delete, reference, enqueue, storage, signed\s+URL, job, evidence, and cache tests deny access under restricted runtime\s+roles with forced RLS\.\s+- Forged or missing tenant context, pooled-connection reuse, composite-FK\s+violations, and membership revocation races fail closed\./,
  },
  {
    label: "roadmap Gate 3 pre-parse raw-byte and network controls",
    pattern:
      /proof\. It must use exact approved hosts and parameters, early raw-response byte\s+limits before parsing, SSRF\/redirect\/time\/decompression controls, snapshot\s+ceilings as defense in depth, bounded retries, reauthorization, and prior-good\s+version preservation\./,
  },
  {
    label: "roadmap Gate 3 raw bytes before object construction",
    pattern:
      /- Raw connector bytes are limited before object construction or parsing; the\s+existing object snapshot and schema budgets still apply afterward\./,
  },
  {
    label: "roadmap Gate 4 upload and parser controls",
    pattern:
      /Uploads enforce raw body and object bytes before parsing, quarantine,\s+tenant-scoped storage, parser isolation, decompression\/workbook complexity\s+limits, and macro, external-link, embedded-object, formula-execution, and\s+formula-injection controls\./,
  },
  {
    label: "roadmap Gate 4 deterministic evidence",
    pattern:
      /All displayed cash-flow metrics are computed by\s+deterministic services and retain workbook, sheet, range, transformation, and\s+time-window evidence\./,
  },
  {
    label: "roadmap Gate 5 zero-call fake provider",
    pattern:
      /- Fake-provider mode exercises the full request and validation path with zero\s+network and zero credential access\./,
  },
  {
    label: "roadmap Gate 5 reject unsafe provider requests before transport",
    pattern:
      /- Provider tools, arbitrary compatible base URLs, unsupported plan\s+credentials, cross-tenant fallback, and requests beyond budget are rejected\s+before transport\./,
  },
  {
    label: "roadmap Gate 5 invalid candidates fail closed",
    pattern:
      /- Invalid `DashboardSpec`, invented or cross-tenant evidence, unsupported\s+calculations, unsafe URLs, non-finite values, and unknown components cannot\s+create a candidate\./,
  },
  {
    label: "roadmap Gate 6 read-only authority boundary",
    pattern:
      /administrator-approved, exact-manifest-pinned, read-only, per-user authorized,\s+resource\/audience-bound, no token passthrough, no sampling or server-initiated\s+model calls, and no transitive action\/Gmail\/Calendar\/Drive-sharing authority\./,
  },
  {
    label: "roadmap Gate 6 no side-effect tools",
    pattern:
      /- A side-effect tool cannot be enabled by configuration or model output\./,
  },
  {
    label: "roadmap Gate 7 exact-deployment entry requirements",
    pattern:
      /- Gates 0 through 5 pass on the exact deployment\. Gate 6 also passes before any\s+Google Sheets or MCP capability is offered\./,
  },
  {
    label: "roadmap Gate 7 owner go-no-go and drills",
    pattern:
      /- The owner records the permitted real-data classes and data-processing terms,\s+named pilot cohort and accepted use cases, liability boundary, and explicit\s+private-pilot go\/no-go decision\.\s+- Restore, credential rotation, revocation, provider\/schedule kill switches,\s+audit sealing, monitoring, rollback, and incident-response drills pass\./,
  },
  {
    label: "roadmap Gate 7 no unresolved isolation blockers",
    pattern:
      /- No unresolved tenant-isolation, secret-handling, ingestion, or authority-race\s+blocker remains\./,
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
    label: "plan honest provider diversity",
    pattern:
      /The six\s+model IDs are distinct, but provider diversity is not six-way: four are\s+Claude-family models and two are OpenAI models run through Codex\./,
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
    label: "validation exact rehearsal stimulus",
    pattern:
      /- Rehearsal stimulus HEAD: `9a8ef6d2dd53156c46118d8d71154d780b0b9c04`\s+- Rehearsal stimulus tree: `76c3e0fe825217479b8876dbb63fc61e0e34329b`/,
  },
  {
    label: "validation stimulus is not containing commit",
    pattern:
      /The hashes above identify the exact dashboard shown during the rehearsal; they\s+do not claim to identify the later commit that contains this governance record\.\s+The containing commit is identified externally by Git, CI, and exact-head review\s+because a commit cannot include its own final hash\./,
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
  {
    label: "rehearsal exact stimulus",
    pattern:
      /dashboard HEAD\s+`9a8ef6d2dd53156c46118d8d71154d780b0b9c04`, tree\s+`76c3e0fe825217479b8876dbb63fc61e0e34329b`/,
  },
  ...modelClauses("rehearsal"),
  {
    label: "rehearsal honest provider diversity",
    pattern:
      /The six model IDs are distinct\. Provider diversity is not six-way: four are\s+Claude-family models and two are OpenAI models run through Codex\./,
  },
  {
    label: "rehearsal explicit thresholds",
    pattern:
      /The owner-approved synthetic thresholds are 5\/6 for four-part content, 5\/6 for\s+predicted evidence reachability, 6\/6 for mechanical replay, 4\/6 for strict\s+displayed types, and 6\/6 for bounded usefulness and need\./,
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
      /\|\s*Chosen evidence path mechanically opened\s*\|\s*6\/6\s*\|\s*6\/6\s*\|/,
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

  it("locks and independently mutation-tests every Gate 2–7 block", () => {
    const actual = parseRoadmapGateBoundaries(roadmap);
    expect(actual).toHaveLength(59);
    expect(actual).toEqual(expectedRoadmapGateBoundaries);
    expect(new Set(actual.map(({ key }) => key)).size).toBe(actual.length);

    const normalizedRoadmap = normalizeWhitespace(
      extractSection(roadmap, "## Gate 2", "## Explicit deferrals"),
    );
    const seenTexts = new Map<string, number>();
    for (const boundary of expectedRoadmapGateBoundaries) {
      const totalOccurrences = expectedRoadmapGateBoundaries.filter(
        ({ text }) => text === boundary.text,
      ).length;
      expect(normalizedRoadmap.split(boundary.text)).toHaveLength(
        totalOccurrences + 1,
      );
      const occurrence = (seenTexts.get(boundary.text) ?? 0) + 1;
      seenTexts.set(boundary.text, occurrence);
      const mutated = replaceOccurrence(
        normalizedRoadmap,
        boundary.text,
        occurrence,
        `[REMOVED ${boundary.key}]`,
      );
      expect(mutated).not.toBe(normalizedRoadmap);
      expect(mutated.split(boundary.text)).toHaveLength(totalOccurrences);

      const alteredText = boundary.text.replace(/[A-Za-z0-9]/, "_");
      const altered = replaceOccurrence(
        normalizedRoadmap,
        boundary.text,
        occurrence,
        alteredText,
      );
      expect(altered).not.toBe(normalizedRoadmap);
      expect(altered.split(boundary.text)).toHaveLength(totalOccurrences);
    }
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

  it("cross-locks the stimulus hashes and rejects additive human fabrication", () => {
    const stimulusHashes = parseStimulusHashes(validation);
    expect(parseStimulusHashes(rehearsal)).toEqual(stimulusHashes);
    for (const document of [validation, rehearsal]) {
      for (const hash of stimulusHashes) {
        expect(document.split(`\`${hash}\``)).toHaveLength(2);
      }
    }
    for (const document of syntheticClaimDocuments) {
      expect(findFabricatedHumanClaims(document)).toEqual([]);
    }

    for (const fabricated of [
      "Seven human participants passed the study.",
      "The dashboard passed validation with six real users.",
      "The study included human participants.",
      "Results are human-equivalent.",
      "Six human sessions occurred.",
      "Seven human participants passed the study with no coaching.",
      "No synthetic agents passed, and seven human participants passed the study.",
      "Seven humans passed with no coaching.",
      "No synthetic agents passed, and seven humans passed.",
      "Seven human participants did not receive coaching and passed.",
    ]) {
      expect(findFabricatedHumanClaims(fabricated)).not.toEqual([]);
    }
    for (const honestNegation of [
      "No human sessions occurred.",
      "Human sessions did not occur.",
      "None of the human participants passed the study.",
      "None participants passed.",
    ]) {
      expect(findFabricatedHumanClaims(honestNegation)).toEqual([]);
    }
  });

  it("locks every per-agent result and derives each record independently", () => {
    const validationRows = parseAgentRows(validation);
    const rehearsalRows = parseAgentRows(rehearsal);
    const validationDerived = deriveAgentResults(validationRows);
    const rehearsalDerived = deriveAgentResults(rehearsalRows);

    expect(validationRows).toEqual(expectedValidationAgentRows);
    expect(rehearsalRows).toEqual(expectedRehearsalAgentRows);
    expect(rehearsalRows).toEqual(validationRows);
    expect(rehearsalDerived).toEqual(validationDerived);
    expect(validationDerived.distinctModels).toBe(6);
    expect(validationDerived.changedTargets).toBe(3);
    expect(validationDerived.nextActionTargets).toBe(3);
    expect(validationDerived.allowedFeedback).toBe(true);

    const derived = validationDerived;

    expect(
      parseBoldAggregate(validation, "Synthetic four-part content recovery"),
    ).toEqual(derived.content);
    expect(
      parseBoldAggregate(
        validation,
        "Predicted requested-evidence path within two interactions",
      ),
    ).toEqual(derived.evidence);
    expect(
      parseBoldAggregate(
        validation,
        "Mechanically valid requested-evidence path in one activation",
      ),
    ).toEqual(derived.mechanical);
    expect(
      parseBoldAggregate(validation, "Strict displayed statement-type mapping"),
    ).toEqual(derived.strictTypes);
    expect(
      parseBoldAggregate(validation, "Bounded usefulness and need collected"),
    ).toEqual(derived.boundedFeedback);
    expect(parseBoldAggregate(validation, "Repeated need")).toEqual(
      derived.namedOwnerNeed,
    );
    expect(
      parseRatio(
        validation,
        /usefulness was \*\*(\d+) of\s+(\d+)\*\* for every agent/,
        "validation usefulness score",
      ),
    ).toEqual(derived.usefulnessScore);

    expect(
      parseTableAggregate(rehearsal, "Four-part content recovered"),
    ).toEqual(rehearsalDerived.content);
    expect(
      parseTableAggregate(
        rehearsal,
        "Predicted evidence path within two interactions",
      ),
    ).toEqual(rehearsalDerived.evidence);
    expect(
      parseTableAggregate(
        rehearsal,
        "Chosen evidence path mechanically opened",
      ),
    ).toEqual(rehearsalDerived.mechanical);
    expect(
      parseTableAggregate(rehearsal, "Strict displayed statement-type mapping"),
    ).toEqual(rehearsalDerived.strictTypes);
    expect(
      parseTableAggregate(rehearsal, "Bounded usefulness and need supplied"),
    ).toEqual(rehearsalDerived.boundedFeedback);
    expect(
      parseRatio(
        rehearsal,
        /Every model rated the dashboard\s+(\d+)\/(\d+) useful\./,
        "rehearsal usefulness score",
      ),
    ).toEqual(rehearsalDerived.usefulnessScore);
    expect(
      parseRatio(
        rehearsal,
        /\*\*(\d+) of (\d+)\*\* selected `Named owner or handoff`/,
        "rehearsal repeated need",
      ),
    ).toEqual(rehearsalDerived.namedOwnerNeed);

    const expectedThresholds = new Map<string, [number, number] | null>([
      ["Four-part content recovered", [5, 6]],
      ["Predicted evidence path within two interactions", [5, 6]],
      ["Chosen evidence path mechanically opened", [6, 6]],
      ["Strict displayed statement-type mapping", [4, 6]],
      ["Bounded usefulness and need supplied", [6, 6]],
    ]);
    expect(parseRehearsalThresholdNarrative(rehearsal)).toEqual(
      expectedThresholds,
    );
    for (const [label, threshold] of expectedThresholds) {
      expect(rehearsal.split(label)).toHaveLength(2);
      expect(parseTableMeasure(rehearsal, label).threshold).toEqual(threshold);
    }
  });

  it("rejects per-agent and displayed-aggregate mutations", () => {
    const validationCellMutations: Array<[number, string]> = [
      [3, "next-action"],
      [4, "MISS"],
      [5, "99"],
      [6, "99"],
      [7, "PASS"],
      [8, "1"],
      [9, "wrong"],
      [10, "Other bounded need"],
    ];
    for (const [column, replacement] of validationCellMutations) {
      expect(
        parseAgentRows(mutateAgentCell(validation, "A01", column, replacement)),
      ).not.toEqual(expectedValidationAgentRows);
    }
    expect(
      parseAgentRows(mutateAgentCell(rehearsal, "A02", 5, "99")),
    ).not.toEqual(expectedRehearsalAgentRows);

    const a06 = rehearsal
      .split("\n")
      .find((line) => /^\|\s*A06\s*\|/.test(line));
    if (!a06) throw new Error("missing A06 row");
    const extraAgent = `${rehearsal}\n${a06.replace("A06", "A07")}`;
    expect(parseAgentRows(extraAgent)).toHaveLength(7);
    expect(parseAgentRows(extraAgent)).not.toEqual(expectedRehearsalAgentRows);

    const misstatedValidationAggregate = validation.replace(
      "Synthetic four-part content recovery: **6 of 6**",
      "Synthetic four-part content recovery: **5 of 6**",
    );
    expect(
      parseBoldAggregate(
        misstatedValidationAggregate,
        "Synthetic four-part content recovery",
      ),
    ).not.toEqual([6, 6]);

    const misstatedRehearsalAggregate = rehearsal.replace(
      "| Four-part content recovered                     |    6/6 |",
      "| Four-part content recovered                     |    5/6 |",
    );
    expect(
      parseTableAggregate(
        misstatedRehearsalAggregate,
        "Four-part content recovered",
      ),
    ).not.toEqual([6, 6]);

    const misstatedRehearsalThreshold = rehearsal.replace(
      "| Four-part content recovered                     |    6/6 |                 5/6 |",
      "| Four-part content recovered                     |    6/6 |                 4/6 |",
    );
    expect(
      parseTableMeasure(
        misstatedRehearsalThreshold,
        "Four-part content recovered",
      ).threshold,
    ).not.toEqual([5, 6]);
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

    const weakenedDownstreamBoundaries: Array<[string, string]> = [
      [
        roadmap.replace(
          "at least 5 of 6 manager-shaped users identify\n  Known, Changed, Important, and Next safe action within 30 seconds",
          "at least 3 of 6 manager-shaped users identify\n  Known, Changed, Important, and Next safe action within 30 seconds",
        ),
        "roadmap Gate 4 retains real-user benchmark",
      ],
      [
        roadmap.replace(
          "The Gate 4 real-user 30-second comprehension and two-interaction evidence",
          "The synthetic Gate 1 comprehension and evidence",
        ),
        "roadmap Gate 7 continues Gate 4 real-user goals",
      ],
      [
        roadmap.replace(
          "PostgreSQL `FORCE ROW LEVEL SECURITY`",
          "PostgreSQL `ROW LEVEL SECURITY`",
        ),
        "roadmap Gate 2 forced tenant isolation",
      ],
      [
        roadmap.replace(
          "Cross-tenant read, count, update, delete, reference, enqueue, storage, signed",
          "Cross-tenant read and update may be allowed",
        ),
        "roadmap Gate 2 cross-tenant denial and fail-closed context",
      ],
      [
        roadmap.replace(
          "exact approved hosts and parameters, early raw-response byte",
          "arbitrary hosts and parameters, late response byte",
        ),
        "roadmap Gate 3 pre-parse raw-byte and network controls",
      ],
      [
        roadmap.replace(
          "Raw connector bytes are limited before object construction or parsing",
          "Raw connector bytes are limited after parsing",
        ),
        "roadmap Gate 3 raw bytes before object construction",
      ],
      [
        roadmap.replace(
          "tenant-scoped storage, parser isolation",
          "shared storage, in-process parsing",
        ),
        "roadmap Gate 4 upload and parser controls",
      ],
      [
        roadmap.replace(
          "All displayed cash-flow metrics are computed by\ndeterministic services",
          "Displayed cash-flow metrics may be generated by\nmodel services",
        ),
        "roadmap Gate 4 deterministic evidence",
      ],
      [
        roadmap.replace(
          "with zero\n  network and zero credential access",
          "with live\n  network and credential access",
        ),
        "roadmap Gate 5 zero-call fake provider",
      ],
      [
        roadmap.replace(
          "requests beyond budget are rejected\n  before transport",
          "requests beyond budget may proceed\n  before review",
        ),
        "roadmap Gate 5 reject unsafe provider requests before transport",
      ],
      [
        roadmap.replace(
          "unknown components cannot\n  create a candidate",
          "unknown components may\n  create a candidate",
        ),
        "roadmap Gate 5 invalid candidates fail closed",
      ],
      [
        roadmap.replace(
          "exact-manifest-pinned, read-only, per-user authorized",
          "unpinned, read-write, shared-account authorized",
        ),
        "roadmap Gate 6 read-only authority boundary",
      ],
      [
        roadmap.replace(
          "A side-effect tool cannot be enabled by configuration or model output",
          "A side-effect tool can be enabled by model output",
        ),
        "roadmap Gate 6 no side-effect tools",
      ],
      [
        roadmap.replace(
          "Gates 0 through 5 pass on the exact deployment",
          "Gates 0 through 5 are planned after deployment",
        ),
        "roadmap Gate 7 exact-deployment entry requirements",
      ],
      [
        roadmap.replace(
          "private-pilot go/no-go decision",
          "automatic private-pilot go decision",
        ),
        "roadmap Gate 7 owner go-no-go and drills",
      ],
      [
        roadmap.replace(
          "No unresolved tenant-isolation, secret-handling, ingestion, or authority-race\n  blocker remains",
          "Known tenant-isolation and authority-race blockers may remain",
        ),
        "roadmap Gate 7 no unresolved isolation blockers",
      ],
    ];
    expect(
      weakenedDownstreamBoundaries.map(([, label]) => label).sort(),
    ).toEqual(
      roadmapClauses
        .filter(({ label }) => /^roadmap Gate [2-7]/.test(label))
        .map(({ label }) => label)
        .sort(),
    );
    for (const [
      mutatedRoadmap,
      expectedMissingClause,
    ] of weakenedDownstreamBoundaries) {
      expect(mutatedRoadmap).not.toBe(roadmap);
      expect(missingClauses(mutatedRoadmap, roadmapClauses)).toContain(
        expectedMissingClause,
      );
    }

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
