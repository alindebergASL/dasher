import {
  parseDashboardSpec,
  type DashboardComponent,
  type DashboardSpec,
  type Evidence,
} from "@dasher/dashboard-schema";
import {
  deriveLedgerFacts,
  periodStart,
  type LedgerFacts,
  type LedgerLineFacts,
  type LedgerSnapshot,
} from "@dasher/ledger-domain";

import {
  assemblePages,
  plannerEvidence,
  uniqueIds,
  type PlannerIdentity,
} from "./planned-spec";
import { findLedgerPlanProblems } from "./ledger-plan";
import type { LedgerPlan, LedgerSectionKind } from "./ledger-plan";

/**
 * A dashboard compiled from a ledger, through the same contract as a dashboard
 * compiled from stations.
 *
 * WHAT THIS IS EVIDENCE FOR. `compilePlan` takes `readonly Station[]`, so until
 * now nothing without coordinates could reach the renderer through a plan. The
 * one non-station dashboard in the product hand-writes its entire
 * `DashboardSpec` as a literal. This file goes the other way: a plan, validated
 * against the snapshot, compiled by trusted code, and handed to
 * `parseDashboardSpec` like everything else.
 *
 * WHAT IT DOES NOT CONTAIN, and the reason a test asserts it rather than a
 * comment: no site id, no latitude, no longitude, no station, gauge, or river.
 * Five of the contract's seven component kinds turn out to be genuinely
 * domain-neutral and are used here unchanged. The two that are not —
 * `station-map` and `station-table` — are simply not built, which is what
 * "generic" is supposed to mean.
 */

type CompiledSpec = Extract<DashboardSpec, { schemaVersion: "1.2" }>;

export interface CompileLedgerOptions {
  asOf: string;
  planner: PlannerIdentity;
  dataMode?: "demo" | "live";
}

export class LedgerPlanRejected extends Error {
  constructor(readonly reasons: readonly string[]) {
    super(`The ledger plan was rejected: ${reasons.join("; ")}`);
    this.name = "LedgerPlanRejected";
  }
}

function money(amount: number, currency: string): string {
  // Whole units. A dashboard that reports operating spend to the cent is
  // reporting noise, and the contract's short-text fields are for a reader.
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(amount);
}

function signedPercent(value: number | null): string {
  if (value === null) return "no prior period";
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function directionOf(change: number): "up" | "down" | "steady" {
  return change > 0 ? "up" : change < 0 ? "down" : "steady";
}

function buildSection(
  section: LedgerSectionKind,
  facts: LedgerFacts,
  lines: readonly LedgerLineFacts[],
  /** Each line's full series, straight from the snapshot. */
  amounts: ReadonlyMap<string, readonly number[]>,
): DashboardComponent | undefined {
  const everything = uniqueIds(
    lines.map((line) => line.evidenceId),
    [facts.calculationEvidenceId],
  );

  switch (section) {
    case "spend-summary":
      return {
        kind: "summary",
        id: "spend-summary",
        title: "Spending summary",
        subtitle: `What was spent in ${facts.latestPeriod}, and what moved.`,
        evidenceIds: everything,
        tone: facts.overBudget.length > 0 ? "attention" : "normal",
        claims: [
          {
            text: `Total spending for ${facts.latestPeriod} was ${money(facts.total, facts.currency)}, ${signedPercent(facts.totalChangePercent)} against ${facts.previousPeriod}.`,
            evidenceIds: everything,
          },
          ...(facts.movers[0] === undefined
            ? []
            : [
                {
                  text: `${facts.movers[0].label} moved most, ${directionOf(facts.movers[0].change) === "down" ? "down" : "up"} ${money(Math.abs(facts.movers[0].change), facts.currency)}.`,
                  evidenceIds: uniqueIds(
                    [facts.movers[0].evidenceId],
                    [facts.calculationEvidenceId],
                  ),
                },
              ]),
          ...(facts.overBudget.length === 0
            ? []
            : [
                {
                  text: `${String(facts.overBudget.length)} line${facts.overBudget.length === 1 ? " is" : "s are"} over budget for the ${facts.periodLabel}.`,
                  evidenceIds: uniqueIds(
                    facts.overBudget.map((line) => line.evidenceId),
                    [facts.calculationEvidenceId],
                  ),
                },
              ]),
        ],
      };

    case "headline-totals":
      return {
        kind: "metric-grid",
        id: "headline-totals",
        title: "At a glance",
        evidenceIds: everything,
        metrics: [
          {
            label: `Total, ${facts.latestPeriod}`,
            value: money(facts.total, facts.currency),
            change: signedPercent(facts.totalChangePercent),
            direction: directionOf(facts.total - facts.previousTotal),
            evidenceIds: everything,
          },
          {
            label: "Lines reported",
            value: String(lines.length),
            evidenceIds: uniqueIds(lines.map((line) => line.evidenceId)),
          },
          {
            label: "Over budget",
            value: String(facts.overBudget.length),
            evidenceIds: everything,
          },
          {
            label: `Largest share`,
            value:
              lines[0] === undefined
                ? "—"
                : `${[...lines].sort((one, two) => two.share - one.share)[0]!.share.toFixed(1)}%`,
            evidenceIds: everything,
          },
        ],
      };

    case "largest-movers": {
      const movers = facts.movers;
      if (movers.length === 0) return undefined;
      return {
        kind: "ranking",
        id: "largest-movers",
        title: "Largest movers",
        subtitle: `Lines ranked by size of change against ${facts.previousPeriod}, either direction.`,
        evidenceIds: everything,
        items: movers.map((line) => ({
          id: line.id,
          label: line.label,
          value: `${line.change >= 0 ? "+" : "−"}${money(Math.abs(line.change), facts.currency)}`,
          note: `${signedPercent(line.changePercent)} · ${line.share.toFixed(1)}% of total`,
          evidenceIds: uniqueIds(
            [line.evidenceId],
            [facts.calculationEvidenceId],
          ),
        })),
      };
    }

    case "line-trends":
      return {
        kind: "trend-list",
        id: "line-trends",
        title: `Spending by ${facts.periodLabel}`,
        evidenceIds: everything,
        series: lines.map((line) => ({
          id: line.id,
          label: line.label,
          unit: facts.currency,
          evidenceIds: [line.evidenceId],
          // `?? []` is unreachable — this map is built from the same snapshot
          // the facts came from — but a `!` here would mean a compiler willing
          // to display a number it never looked up. An empty series fails the
          // contract loudly instead, which is the honest failure.
          points: (amounts.get(line.id) ?? []).map((value, index) => ({
            at: periodStart(facts.periods[index]!),
            value,
          })),
        })),
      };

    case "over-budget": {
      // Nothing over budget is a real answer, and an empty panel is not one.
      // `assemblePages` drops the section, and the page with it if it was the
      // only one — the same rule the station compiler uses for a quiet river.
      // Already narrowed to the plan's lines, so what is over budget here is
      // what the reader can see.
      if (facts.overBudget.length === 0) return undefined;
      const selected = facts.overBudget;
      return {
        kind: "alert-list",
        id: "over-budget",
        title: "Over budget",
        evidenceIds: uniqueIds(
          selected.map((line) => line.evidenceId),
          [facts.calculationEvidenceId],
        ),
        alerts: selected.map((line) => ({
          id: `over-${line.id}`,
          severity: "attention" as const,
          title: line.label,
          detail: `${money(line.latest, facts.currency)} against a ${money(line.budgetPerPeriod ?? 0, facts.currency)} budget, over by ${money(line.overBudgetBy ?? 0, facts.currency)}.`,
          evidenceIds: uniqueIds(
            [line.evidenceId],
            [facts.calculationEvidenceId],
          ),
        })),
      };
    }
  }
}

export function compileLedgerPlan(
  plan: LedgerPlan,
  snapshot: LedgerSnapshot,
  options: CompileLedgerOptions,
): CompiledSpec {
  /**
   * VALIDATE BEFORE COMPILING, HERE RATHER THAN AT THE CALL SITE.
   *
   * `findLedgerPlanProblems` was written, exported, and called by nothing — not
   * by the server action, not by a test. The action went straight from
   * `planLedgerDashboard` to this function, so an invented budget line was
   * silently dropped by the filter below instead of refused, a duplicated
   * section was never reported, and no free-text field was read at all. The
   * comment at that call site said the ledger "takes the same route the river
   * does — a plan, checked against the snapshot that exists"; the checking step
   * did not exist.
   *
   * Putting it inside the compiler rather than beside it is what makes that
   * unrepeatable. There is no longer a way to compile a ledger plan without
   * validating it, so the next source cannot inherit the same omission by
   * forgetting a line.
   */
  const problems = findLedgerPlanProblems(
    plan,
    snapshot.lines.map((line) => line.id),
  );
  if (problems.length > 0) {
    throw new LedgerPlanRejected(problems.map((problem) => problem.message));
  }

  /**
   * THE PLAN'S SELECTION NARROWS THE LEDGER BEFORE ANY FIGURE IS COMPUTED, and
   * that order matters more than it looks. Deriving over the whole snapshot and
   * filtering afterwards was the first version, and no test caught it until one
   * selected a single line: the total, every share, and the largest mover were
   * computed across lines the reader had not asked for and could not see. A
   * dashboard showing one line beside a six-line total is not a partial view,
   * it is a wrong one.
   */
  const lines = plan.lineIds
    .map((lineId) => snapshot.lines.find((line) => line.id === lineId))
    .filter(
      (line): line is (typeof snapshot.lines)[number] => line !== undefined,
    );

  if (lines.length === 0) {
    throw new LedgerPlanRejected([
      "No line in this plan exists in the ledger, so there is nothing to compile.",
    ]);
  }

  const facts = deriveLedgerFacts({ ...snapshot, lines });
  const selected = facts.lines;
  /**
   * `LedgerLineFacts` carries only the two periods that get compared, so a
   * trend needs the selected lines' own series. Passed explicitly rather than
   * copied onto the facts, so there is one history rather than two that drift.
   */
  const amounts = new Map<string, readonly number[]>(
    lines.map((line) => [line.id, line.amounts]),
  );

  const pages = assemblePages(plan.pages, (section) =>
    buildSection(section, facts, selected, amounts),
  );

  if (pages.length === 0) {
    throw new LedgerPlanRejected([
      "Every section in this plan produced nothing, so the dashboard would be empty.",
    ]);
  }

  const everything = uniqueIds(
    selected.map((line) => line.evidenceId),
    [facts.calculationEvidenceId],
  );
  const biggest = [...selected].sort((one, two) => two.share - one.share)[0]!;
  const evidence: Evidence[] = [
    ...facts.evidence,
    plannerEvidence(options.planner, "budget line", options.asOf),
  ];

  return parseDashboardSpec({
    schemaVersion: "1.2",
    id: "planned-ledger-spending",
    title: plan.title,
    audience: plan.audience,
    generatedAt: options.asOf,
    dataMode: options.dataMode ?? "demo",
    freshness: {
      // A ledger is not a sensor. It is not stale between closes, it is simply
      // as of a period — so freshness names the period rather than inventing a
      // staleness the source has no notion of.
      status: "partial",
      label: `Ledger as of ${facts.latestPeriod}; one ${facts.periodLabel} behind close`,
      // `latestObservationAt` is deliberately absent. It is optional, the shell
      // renders it as a clock time, and a monthly ledger has no instant of
      // observation — the first render of this dashboard said "Latest
      // observation 12:00 AM UTC", which is a fact about `periodStart` rather
      // than about the ledger. The period is in the label, where it is true.
    },
    executiveBrief: {
      known: {
        statementTypes: ["observed", "calculated"],
        headline: `${money(facts.total, facts.currency)} across ${String(selected.length)} lines`,
        detail: `${String(selected.length)} budget line${selected.length === 1 ? "" : "s"} reported spending for ${facts.latestPeriod}, totalling ${money(facts.total, facts.currency)}.`,
        evidenceIds: everything,
      },
      changed: {
        statementTypes: ["calculated"],
        headline: `${signedPercent(facts.totalChangePercent)} against ${facts.previousPeriod}`,
        detail: `Total spending moved from ${money(facts.previousTotal, facts.currency)} to ${money(facts.total, facts.currency)}.`,
        evidenceIds: everything,
      },
      important: {
        statementTypes: ["interpreted"],
        headline:
          facts.overBudget.length > 0
            ? `${String(facts.overBudget.length)} line${facts.overBudget.length === 1 ? "" : "s"} over budget`
            : `${biggest.label} is the largest share`,
        detail:
          facts.overBudget.length > 0
            ? `${facts.overBudget.map((line) => line.label).join(", ")} exceeded the budget set for one ${facts.periodLabel}.`
            : `${biggest.label} accounts for ${biggest.share.toFixed(1)}% of spending in ${facts.latestPeriod}.`,
        evidenceIds: everything,
      },
    },
    nextAction: {
      title: "Review the ledger export",
      detail: `Confirm the ${facts.latestPeriod} figures against the source export before circulating. Dasher compares against budgets recorded in the snapshot and does not know about commitments, accruals, or reclassifications.`,
      evidenceIds: everything,
    },
    pages,
    evidence,
    architecture: {
      title: "How this dashboard was built",
      summary:
        "A normalized ledger snapshot is validated, a planner chooses the composition, and Dasher computes every figure before the dashboard is checked against the contract.",
      nodes: [
        {
          id: "ledger-source",
          kind: "input",
          label: "Ledger export",
          detail: `Amounts per budget line per ${facts.periodLabel}, with the budget each line was given.`,
        },
        {
          id: "ledger-facts",
          kind: "process",
          label: "Dasher calculations",
          detail:
            "Totals, period-over-period change, share of total, and budget comparisons, computed from the recorded amounts.",
        },
        {
          id: "ledger-planner",
          kind: options.planner.usesModel ? "ai" : "process",
          label: "Composition",
          detail: `Chose the title, audience, framing, line selection, and page layout. Planner: ${options.planner.id}.`,
        },
        {
          id: "ledger-dashboard",
          kind: "output",
          label: "Dashboard",
          detail:
            "Validated against the dashboard contract before display, with evidence behind every figure.",
        },
      ],
      edges: [
        { from: "ledger-source", to: "ledger-facts", label: "amounts" },
        { from: "ledger-facts", to: "ledger-dashboard", label: "figures" },
        { from: "ledger-planner", to: "ledger-dashboard", label: "layout" },
      ],
    },
    notice: `Figures come from a normalized ledger export and are as of ${facts.latestPeriod}. Planning view only; use the accounting system of record for reporting.`,
  }) as CompiledSpec;
}
