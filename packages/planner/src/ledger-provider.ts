import {
  LEDGER_SECTION_KINDS,
  LedgerPlanSchema,
  type LedgerPlan,
  type LedgerSectionKind,
} from "./ledger-plan";

/**
 * A deterministic ledger planner.
 *
 * The station side has `FakePlanningProvider`, and this is its counterpart, not
 * a generalisation of it: the two produce different plan shapes and share no
 * code. Merging them would mean one provider that returns a union and a caller
 * that asks which arm it got, which is more indirection than two small
 * functions deserve.
 *
 * Its job in this slice is to prove the PATH, not to be a good planner. It
 * varies composition on a couple of request words so that "what did I ask for"
 * visibly changes the dashboard, and the request text is otherwise ignored. The
 * ceiling here is deliberately low; the model-backed planner is what raises it,
 * and that is a different slice with its own gates.
 */

export interface LedgerPlannerIdentity {
  readonly id: string;
  readonly usesModel: boolean;
}

export const DETERMINISTIC_LEDGER_PLANNER: LedgerPlannerIdentity = {
  id: "fake-ledger-planner-v1",
  usesModel: false,
};

/**
 * "over" is not here, and the omission is the point. It matched "over time" —
 * a trend request — and routed it to the budget composition. The domain router
 * learned the same lesson with `\briver\b` and "Riverside": a word earns its
 * place by being unambiguous, not by being related to the subject.
 */
const BUDGET_WORDS = /\b(?:budgets?|over[\s-]budget|overspend|variance)\b/iu;
const TREND_WORDS = /\b(?:trend|trends|over time|history|monthly)\b/iu;

/**
 * Sections in the order a reader meets them. A budget-framed request leads with
 * what is over; a trend-framed one leads with movement. Everything else gets
 * the plain ordering.
 */
function sectionsFor(requestText: string): LedgerSectionKind[] {
  if (BUDGET_WORDS.test(requestText)) {
    return [
      "spend-summary",
      "headline-totals",
      "over-budget",
      "largest-movers",
    ];
  }
  if (TREND_WORDS.test(requestText)) {
    return [
      "spend-summary",
      "headline-totals",
      "line-trends",
      "largest-movers",
    ];
  }
  return ["spend-summary", "headline-totals", "largest-movers", "over-budget"];
}

function titleFor(requestText: string): string {
  if (BUDGET_WORDS.test(requestText)) return "Operating Spend — Budget Watch";
  if (TREND_WORDS.test(requestText)) return "Operating Spend — Movement";
  return "Operating Spend";
}

function audienceFor(requestText: string): string {
  return BUDGET_WORDS.test(requestText)
    ? "Budget owners reviewing variances"
    : "Finance and operations leads";
}

export function planLedgerDashboard(
  requestText: string,
  lineIds: readonly string[],
): LedgerPlan {
  const sections = sectionsFor(requestText);
  // Parsed rather than returned raw, for the same reason a provider's output is
  // parsed on the station side: this is the only structure the compiler trusts,
  // and a planner that drifts from it should fail here rather than downstream.
  return LedgerPlanSchema.parse({
    planVersion: "ledger-plan-v1",
    title: titleFor(requestText),
    audience: audienceFor(requestText),
    framing: BUDGET_WORDS.test(requestText)
      ? "Ordered for a budget review: what was spent, what is over, and what moved."
      : "What was spent this period, how it moved, and which lines account for it.",
    lineIds: [...lineIds],
    pages: [
      {
        id: "spending",
        title: "Spending",
        description: `Current period spending across ${String(lineIds.length)} budget lines.`,
        sections,
      },
    ],
  });
}

export { LEDGER_SECTION_KINDS };
