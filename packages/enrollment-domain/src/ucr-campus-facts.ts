import {
  parseDashboardSpec,
  type DashboardSpec,
} from "@dasher/dashboard-schema";
import { z } from "zod";

const SOURCE_NAME = "UC Riverside Institutional Research";
const SOURCE_URL = "https://ir.ucr.edu/campus-facts-tables";
const CENSUS_DEFINITION =
  "Counts represent distinct students who are enrolled in credit-bearing classes as of the fall third-week census.";
const MAX_HTML_BYTES = 1_000_000;

const EnrollmentYearSchema = z.strictObject({
  year: z.number().int().min(2000).max(2100),
  undergraduate: z.number().int().nonnegative(),
  graduate: z.number().int().nonnegative(),
  total: z.number().int().positive(),
});

export const EnrollmentSnapshotSchema = z.strictObject({
  institution: z.literal("University of California, Riverside"),
  term: z.string().regex(/^Fall \d{4}$/u),
  censusDefinition: z.literal(CENSUS_DEFINITION),
  sourceName: z.literal(SOURCE_NAME),
  sourceUrl: z.literal(SOURCE_URL),
  retrievedAt: z.string().datetime({ offset: true }),
  history: z.array(EnrollmentYearSchema).min(2).max(100),
});

export type EnrollmentSnapshot = z.infer<typeof EnrollmentSnapshotSchema>;

export interface ParseUcrCampusFactsOptions {
  readonly retrievedAt: string;
  readonly sourceUrl?: string;
}

/**
 * Parse the public UCR Institutional Research campus-facts page.
 *
 * Source-specific on purpose: this experiment asks whether one official source
 * can become an honest dashboard. It does not claim arbitrary HTML support and
 * refuses when UCR changes the named section, labels, census definition, row
 * arithmetic, or narrative/table agreement.
 */
export function parseUcrCampusFactsHtml(
  html: string,
  options: ParseUcrCampusFactsOptions,
): EnrollmentSnapshot {
  if (new TextEncoder().encode(html).byteLength > MAX_HTML_BYTES) {
    throw new Error(
      `UCR campus-facts HTML exceeds ${String(MAX_HTML_BYTES)} bytes`,
    );
  }
  if ((options.sourceUrl ?? SOURCE_URL) !== SOURCE_URL) {
    throw new Error(
      "UCR enrollment source URL is not the approved official source",
    );
  }

  const section = enrollmentSection(html);
  const heading = textOf(firstMatch(section, /<h4\b[^>]*>([\s\S]*?)<\/h4>/iu));
  const headingMatch = /^Enrollment - Fall (\d{4})$/u.exec(heading);
  if (headingMatch === null) {
    throw new Error("UCR enrollment section has no supported Fall heading");
  }
  const termYear = parseInteger(headingMatch[1]!, "term year");

  const overview = textOf(
    firstMatch(
      section,
      /<h5\b[^>]*>\s*Overview\s*<\/h5>\s*<p\b[^>]*>([\s\S]*?)<\/p>/iu,
    ),
  );
  if (!overview.includes(`In the Fall ${String(termYear)} term`)) {
    throw new Error("UCR enrollment overview and section term disagree");
  }
  const table = firstMatch(section, /<table\b[^>]*>([\s\S]*?)<\/table>/iu);
  const rows = tableRows(table);
  if (rows.length !== 4) {
    throw new Error(
      "UCR enrollment table must contain one header and three data rows",
    );
  }

  const header = rows[0]!;
  const years = header
    .slice(1)
    .map((value) => parseInteger(value, "table year"));
  if (years.length < 2 || new Set(years).size !== years.length) {
    throw new Error("UCR enrollment table years are missing or duplicated");
  }
  for (let index = 1; index < years.length; index += 1) {
    if (years[index]! <= years[index - 1]!) {
      throw new Error("UCR enrollment table years are not strictly increasing");
    }
  }
  if (years.at(-1) !== termYear) {
    throw new Error("UCR enrollment heading and latest table year disagree");
  }

  const values = new Map<string, number[]>();
  for (const row of rows.slice(1)) {
    const [label, ...cells] = row;
    if (label === undefined || cells.length !== years.length) {
      throw new Error("UCR enrollment table row has an unexpected width");
    }
    if (values.has(label)) {
      throw new Error(`UCR enrollment table duplicates ${label}`);
    }
    values.set(
      label,
      cells.map((cell) => parseCount(cell, label)),
    );
  }

  const undergraduate = requiredRow(values, "Undergraduate Enrollment");
  const graduate = requiredRow(values, "Graduate Enrollment");
  const total = requiredRow(values, "Total Enrollment");
  if (values.size !== 3) {
    throw new Error("UCR enrollment table contains an unknown data row");
  }

  const history = years.map((year, index) => {
    const entry = {
      year,
      undergraduate: undergraduate[index]!,
      graduate: graduate[index]!,
      total: total[index]!,
    };
    if (entry.undergraduate + entry.graduate !== entry.total) {
      throw new Error(`UCR enrollment arithmetic fails for ${String(year)}`);
    }
    return entry;
  });

  const latest = history.at(-1)!;
  const undergraduateShare = (latest.undergraduate / latest.total) * 100;
  const graduateShare = (latest.graduate / latest.total) * 100;
  for (const expected of [
    formatCount(latest.total),
    formatCount(latest.undergraduate),
    formatCount(latest.graduate),
    `${undergraduateShare.toFixed(1)}%`,
    `${graduateShare.toFixed(1)}%`,
  ]) {
    if (!overview.includes(expected)) {
      throw new Error(
        `UCR enrollment overview disagrees with the table: ${expected}`,
      );
    }
  }

  if (!textOf(section).includes(CENSUS_DEFINITION)) {
    throw new Error("UCR enrollment census definition is missing or changed");
  }

  return EnrollmentSnapshotSchema.parse({
    institution: "University of California, Riverside",
    term: `Fall ${String(termYear)}`,
    censusDefinition: CENSUS_DEFINITION,
    sourceName: SOURCE_NAME,
    sourceUrl: SOURCE_URL,
    retrievedAt: options.retrievedAt,
    history,
  });
}

/** Build one honest non-sensor dashboard directly from the enrollment source. */
export function buildUcrEnrollmentDashboard(
  snapshot: EnrollmentSnapshot,
): DashboardSpec {
  const parsed = EnrollmentSnapshotSchema.parse(snapshot);
  const latest = parsed.history.at(-1)!;
  const previous = parsed.history.at(-2)!;
  const yearChange = ((latest.total - previous.total) / previous.total) * 100;
  const undergraduateShare = (latest.undergraduate / latest.total) * 100;
  const graduateShare = (latest.graduate / latest.total) * 100;
  const sourceEvidence = "ucr-enrollment-census";
  const calculationEvidence = "ucr-enrollment-calculations";
  const direction = yearChange > 0 ? "up" : yearChange < 0 ? "down" : "steady";

  return parseDashboardSpec({
    schemaVersion: "1.2",
    id: `ucr-enrollment-fall-${String(latest.year)}`,
    title: `UC Riverside Enrollment — Fall ${String(latest.year)}`,
    audience: "People seeking an official current enrollment snapshot",
    generatedAt: parsed.retrievedAt,
    dataMode: "demo",
    freshness: {
      status: "partial",
      label: `Official Fall ${String(latest.year)} third-week census snapshot; not real-time`,
    },
    executiveBrief: {
      known: {
        statementTypes: ["observed"],
        headline: `${formatCount(latest.total)} students enrolled`,
        detail: `${formatCount(latest.undergraduate)} undergraduate and ${formatCount(latest.graduate)} graduate students were counted in UCR's Fall ${String(latest.year)} third-week census.`,
        evidenceIds: [sourceEvidence],
      },
      changed: {
        statementTypes: ["calculated"],
        headline: `${signedPercent(yearChange)} from Fall ${String(previous.year)}`,
        detail: `Total enrollment changed from ${formatCount(previous.total)} to ${formatCount(latest.total)} students.`,
        evidenceIds: [sourceEvidence, calculationEvidence],
      },
      important: {
        statementTypes: ["interpreted"],
        headline: "A census snapshot, not a live headcount",
        detail: parsed.censusDefinition,
        evidenceIds: [sourceEvidence],
      },
    },
    nextAction: {
      title: "Review the official enrollment source",
      detail:
        "Use UCR Institutional Research for definitions and any breakdown not shown in this experiment.",
      evidenceIds: [sourceEvidence],
    },
    notice: `${parsed.term} enrollment snapshot. ${parsed.censusDefinition} This experiment does not infer current-day attendance or combine other sources.`,
    pages: [
      {
        id: "enrollment-overview",
        title: "Enrollment overview",
        description:
          "Current official enrollment totals and the comparable prior fall term.",
        components: [
          {
            id: "enrollment-summary",
            kind: "summary",
            title: `${parsed.term} enrollment`,
            subtitle: "Official UCR Institutional Research census counts",
            tone: "normal",
            claims: [
              {
                text: `${formatCount(latest.total)} students were enrolled in ${parsed.term}.`,
                evidenceIds: [sourceEvidence],
              },
              {
                text: `${formatCount(latest.undergraduate)} were undergraduate (${undergraduateShare.toFixed(1)}%) and ${formatCount(latest.graduate)} were graduate (${graduateShare.toFixed(1)}%).`,
                evidenceIds: [sourceEvidence, calculationEvidence],
              },
              {
                text: `Total enrollment changed ${signedPercent(yearChange)} from Fall ${String(previous.year)}.`,
                evidenceIds: [sourceEvidence, calculationEvidence],
              },
            ],
            evidenceIds: [sourceEvidence, calculationEvidence],
          },
          {
            id: "enrollment-metrics",
            kind: "metric-grid",
            title: "At a glance",
            metrics: [
              {
                label: "Total enrollment",
                value: formatCount(latest.total),
                change: `${signedPercent(yearChange)} year over year`,
                direction,
                evidenceIds: [sourceEvidence, calculationEvidence],
              },
              {
                label: "Undergraduate",
                value: formatCount(latest.undergraduate),
                change: `${undergraduateShare.toFixed(1)}% of total`,
                evidenceIds: [sourceEvidence, calculationEvidence],
              },
              {
                label: "Graduate",
                value: formatCount(latest.graduate),
                change: `${graduateShare.toFixed(1)}% of total`,
                evidenceIds: [sourceEvidence, calculationEvidence],
              },
            ],
            evidenceIds: [sourceEvidence, calculationEvidence],
          },
          {
            id: "enrollment-by-level",
            kind: "ranking",
            title: "Enrollment by level",
            subtitle: "Fall third-week census",
            items: [
              {
                id: "undergraduate",
                label: "Undergraduate",
                value: `${formatCount(latest.undergraduate)} students`,
                note: `${undergraduateShare.toFixed(1)}% of total enrollment`,
                evidenceIds: [sourceEvidence, calculationEvidence],
              },
              {
                id: "graduate",
                label: "Graduate",
                value: `${formatCount(latest.graduate)} students`,
                note: `${graduateShare.toFixed(1)}% of total enrollment`,
                evidenceIds: [sourceEvidence, calculationEvidence],
              },
            ],
            evidenceIds: [sourceEvidence, calculationEvidence],
          },
        ],
      },
    ],
    evidence: [
      {
        id: sourceEvidence,
        kind: "observed",
        label: `${parsed.term} enrollment census`,
        sourceName: parsed.sourceName,
        sourceUrl: parsed.sourceUrl,
        retrievedAt: parsed.retrievedAt,
        detail: `${parsed.censusDefinition} The source table reports undergraduate, graduate, and total enrollment for fall terms ${String(parsed.history[0]!.year)} through ${String(latest.year)}.`,
        confidence: "high",
      },
      {
        id: calculationEvidence,
        kind: "calculated",
        label: "Dasher enrollment calculations",
        sourceName: "Dasher",
        retrievedAt: parsed.retrievedAt,
        detail:
          "Undergraduate and graduate shares and the one-year total change are calculated from the UCR source table; no additional data source is used.",
        confidence: "high",
      },
    ],
    architecture: {
      title: "How this enrollment dashboard works",
      summary:
        "Dasher parsed one captured official UCR Institutional Research page, checked its table arithmetic and definitions, calculated a small set of comparisons, and validated the result against the dashboard contract.",
      nodes: [
        {
          id: "ucr-source",
          label: "UCR Institutional Research",
          detail:
            "The official campus-facts page and its Fall enrollment table.",
          kind: "input",
        },
        {
          id: "parse-enrollment",
          label: "Parse and check",
          detail:
            "Dasher checks the named enrollment section, term, labels, census definition, table width, and row arithmetic.",
          kind: "process",
        },
        {
          id: "calculate-enrollment",
          label: "Calculate comparisons",
          detail:
            "Dasher calculates level shares and the comparable one-year total change.",
          kind: "process",
        },
        {
          id: "validate-dashboard",
          label: "Validate dashboard",
          detail:
            "The completed dashboard must pass the shared schema before it can render.",
          kind: "process",
        },
        {
          id: "enrollment-page",
          label: "Enrollment dashboard",
          detail:
            "A current official snapshot with its definition and evidence attached.",
          kind: "page",
        },
      ],
      edges: [
        { from: "ucr-source", to: "parse-enrollment", label: "captured HTML" },
        {
          from: "parse-enrollment",
          to: "calculate-enrollment",
          label: "validated counts",
        },
        {
          from: "calculate-enrollment",
          to: "validate-dashboard",
          label: "dashboard draft",
        },
        {
          from: "validate-dashboard",
          to: "enrollment-page",
          label: "contract-valid spec",
        },
      ],
    },
  });
}

function enrollmentSection(html: string): string {
  const start = /\bid=["']enrollment["']/iu.exec(html);
  if (start === null) throw new Error("UCR enrollment section is missing");
  const end = /\bid=["']student-demographics["']/iu.exec(
    html.slice(start.index + start[0].length),
  );
  if (end === null)
    throw new Error("UCR enrollment section boundary is missing");
  return html.slice(start.index, start.index + start[0].length + end.index);
}

function firstMatch(input: string, pattern: RegExp): string {
  const match = pattern.exec(input);
  if (match?.[1] === undefined)
    throw new Error(`UCR source did not match ${pattern.source}`);
  return match[1];
}

function tableRows(table: string): string[][] {
  const rows = [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/giu)];
  return rows.map((row) => {
    const cells = [
      ...row[1]!.matchAll(/<(?:th|td)\b[^>]*>([\s\S]*?)<\/(?:th|td)>/giu),
    ];
    return cells.map((cell) => textOf(cell[1]!));
  });
}

function textOf(fragment: string): string {
  return decodeEntities(
    fragment
      .replace(/<!--[\s\S]*?-->/gu, " ")
      .replace(/<(?:script|style)\b[\s\S]*?<\/(?:script|style)>/giu, " ")
      .replace(/<[^>]+>/gu, " ")
      .replace(/\s+/gu, " ")
      .trim(),
  );
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return value.replace(
    /&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/giu,
    (
      entity,
      decimal: string | undefined,
      hexadecimal: string | undefined,
      name: string | undefined,
    ) => {
      if (decimal !== undefined) return String.fromCodePoint(Number(decimal));
      if (hexadecimal !== undefined)
        return String.fromCodePoint(Number.parseInt(hexadecimal, 16));
      return name === undefined
        ? entity
        : (named[name.toLowerCase()] ?? entity);
    },
  );
}

function parseInteger(value: string, label: string): number {
  if (!/^\d+$/u.test(value))
    throw new Error(`${label} is not an integer: ${value}`);
  return Number(value);
}

function parseCount(value: string, label: string): number {
  const compact = value.replaceAll(",", "");
  if (!/^\d+$/u.test(compact))
    throw new Error(`${label} contains a non-count value: ${value}`);
  return Number(compact);
}

function requiredRow(rows: Map<string, number[]>, label: string): number[] {
  const row = rows.get(label);
  if (row === undefined)
    throw new Error(`UCR enrollment table is missing ${label}`);
  return row;
}

function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(
    value,
  );
}

function signedPercent(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}
