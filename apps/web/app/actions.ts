"use server";

import { randomUUID } from "node:crypto";

import {
  DashboardPlanSchema,
  isUninterpretable,
  PlanRejected,
  readRefinementIntent,
  runPlanner,
  type DashboardPlan,
  type PlannerRunOptions,
} from "@dasher/planner";
import { withDashboardRepository } from "@dasher/control-plane";
import {
  canonicalSpecBytes,
  type DashboardSpec,
} from "@dasher/dashboard-schema";
import { getPool, isPersistenceConfigured } from "./database";
import { classifyRequest, type DomainEntry } from "./domains";
import { loadDomainSnapshot, SourceUnavailableError } from "./source-runtime";
import { readSessionCredential } from "./session";

import {
  REFINEMENT_MAX_LENGTH,
  REQUEST_MAX_LENGTH,
  type PlanResult,
} from "./planning";

/**
 * Nothing here trusts its arguments. A server action is a public endpoint —
 * anything that can reach the page can call it with anything — so request text
 * is bounded and the previous plan a refinement carries is re-parsed against
 * the contract rather than accepted because the browser sent it back.
 *
 * The round trip is safe in a second way, which is why it is worth preferring
 * over replaying the whole conversation server-side: a plan carries composition
 * only. Even a doctored one can only change which sections appear, and it then
 * goes through the site check, the free-text gate, the trusted compiler, and
 * the dashboard contract exactly as a provider's own output does.
 */

function tooLong(text: string, limit: number, label: string): string {
  return `${label} are limited to ${limit} characters. Yours is ${text.length}.`;
}

/**
 * Persist a generated dashboard, when there is somewhere and someone to persist
 * it for.
 *
 * WHY IT IS CONDITIONAL, AND WHY THAT IS NOT A SILENT FALLBACK. Two states are
 * ordinary and neither is a failure: the app configured without a database at
 * all — the fixture demo predates the control plane and still runs — and a
 * browser with no session, which is every browser until the development
 * bootstrap has been called. In both, a dashboard is generated and rendered and
 * simply has no durable identity.
 *
 * What is NOT tolerated is a database and a session that are present and a save
 * that fails. That is reported, because a persistence slice whose failure mode
 * is "the page looked fine" would be indistinguishable from not having built it.
 */
async function persist(
  requestText: string,
  dashboard: DashboardSpec,
  title: string,
): Promise<string | undefined> {
  if (!isPersistenceConfigured()) return undefined;

  const credential = await readSessionCredential();
  if (credential === undefined) return undefined;

  const saved = await withDashboardRepository(
    getPool(),
    credential,
    async (repository) =>
      repository.save({
        title,
        requestText,
        // The fake provider is what actually composed this, and the run row is
        // provenance. Recording "fake" is the honest entry; a real provider
        // name here would be a claim about how the dashboard was made.
        provider: "fake",
        model: "fake-planner",
        canonicalSpecBytes: canonicalSpecBytes(dashboard),
        requestId: randomUUID(),
        deploymentRevision: process.env["DASHER_DEPLOYMENT_REVISION"] ?? "dev",
      }),
  );

  return saved.dashboardId;
}

/**
 * Plan, then persist — in that order, and in separate failure domains.
 *
 * They were briefly one `try`, which was wrong in a way worth recording: a
 * failure to save came back as "Something went wrong building that dashboard",
 * so a database problem read as a planning problem. It also broke the build,
 * because `/` was still statically generated and `cookies()` throws there — a
 * error that arrived disguised as the planner refusing a request.
 *
 * The dashboard is real whether or not it was saved, so a persistence failure
 * must not discard it, and must not be silent either.
 */
async function planAndPersist(
  requestText: string,
  refine?: PlannerRunOptions["refine"],
  persistThis = true,
): Promise<PlanResult> {
  const planned = await plan(requestText, refine);
  if (
    !persistThis ||
    !planned.ok ||
    planned.dashboard === undefined ||
    refine !== undefined
  ) {
    // Only fresh generations get a durable identity in this slice. A refinement
    // produces a new version of a dashboard already on screen, and versioning
    // on refine needs the head revision it saw — the update path, not this one.
    return planned;
  }

  try {
    const dashboardId = await persist(
      requestText,
      planned.dashboard,
      planned.plan?.title ?? requestText,
    );
    return dashboardId === undefined ? planned : { ...planned, dashboardId };
  } catch {
    // The dashboard stands; only its durability failed. Saying so is the point
    // — a persistence slice whose failure mode is "the page looked fine" would
    // be indistinguishable from not having built it.
    return {
      ...planned,
      error: "This dashboard was built but could not be saved.",
    };
  }
}

async function plan(
  requestText: string,
  refine?: PlannerRunOptions["refine"],
): Promise<PlanResult> {
  // Deterministic routing, closed on failure. The product supports two
  // domains; a request that names neither gets an explanation, a request
  // that names both gets a choice — and NOTHING falls back to the river.
  // "UC Riverside enrollment" must not produce a Sacramento river dashboard.
  const decision = classifyRequest(requestText);
  if (decision.kind === "unsupported") {
    return {
      ok: false,
      error:
        "Dasher currently builds dashboards for river conditions and air quality. Try \u201criver conditions near Sacramento\u201d or \u201cair quality across Sacramento\u201d.",
    };
  }
  if (decision.kind === "ambiguous") {
    return {
      ok: false,
      error:
        "That asks about both river conditions and air quality. Ask for one dashboard at a time, and you can build the other one next.",
    };
  }
  const domain: DomainEntry = decision.domain;

  // Fetched only now: after routing has chosen exactly one domain, and only
  // because a reader asked for a dashboard. No other path in this app —
  // landing render, the listing, reopening a saved dashboard — reaches a
  // network, and a request the router refused never gets this far.
  let snapshot;
  try {
    snapshot = await loadDomainSnapshot(domain.key);
  } catch (error) {
    if (error instanceof SourceUnavailableError) {
      // Refuse, and persist nothing. The alternative — serving the committed
      // fixture when the live source is down — would present yesterday's
      // sample as current conditions, which is the one failure this product
      // cannot have.
      return {
        ok: false,
        error: `Live ${domain.label} data is temporarily unavailable; try again.`,
      };
    }
    throw error;
  }
  const gauges = snapshot.stations;

  try {
    const run = await runPlanner({
      requestText,
      gauges,
      provider: domain.provider,
      asOf: snapshot.asOf,
      thresholds: domain.thresholds,
      computation: domain.computation,
      words: domain.words,
      ...(refine === undefined ? {} : { refine }),
    });
    const same =
      refine !== undefined &&
      JSON.stringify(run.plan) === JSON.stringify(refine.previousPlan);
    return {
      ok: true,
      dashboard: run.dashboard,
      plan: run.plan,
      attempts: run.attempts.length,
      // An identical plan has two very different causes. Reporting both as
      // "not understood" tells a reader their working request failed — the
      // shipped "Add the history chart" chip does exactly that on the default
      // dashboard, which already has one.
      ...(same
        ? {
            refinement: isUninterpretable(
              readRefinementIntent(
                refine.instruction,
                gauges.map((gauge) => ({
                  siteId: gauge.siteId,
                  name: gauge.name,
                  river: gauge.group,
                })),
              ),
            )
              ? ("not-understood" as const)
              : ("already-satisfied" as const),
          }
        : {}),
    };
  } catch (error) {
    if (error instanceof PlanRejected) {
      return {
        ok: false,
        error:
          `Dasher could not build a dashboard it could stand behind for that request. ${error.findings[0]?.message ?? ""}`.trim(),
      };
    }
    return {
      ok: false,
      error: "Something went wrong building that dashboard. Try rewording it.",
    };
  }
}

/**
 * `persist: false` for the page's own default render.
 *
 * `/` builds a dashboard on every visit, and once it became dynamic that meant
 * a row per authenticated page load — none of them reachable, because the
 * default render does not thread an id into the workspace. Probing left five
 * behind before this was noticed, and the end-to-end suite adds one per
 * `goto("/")`.
 *
 * Persisting is what a reader asks for by submitting a request, so that is when
 * it happens. An implicit save of something nobody typed is not durability, it
 * is litter with a primary key.
 */
export async function planDashboard(
  requestText: string,
  options: { persist?: boolean } = {},
): Promise<PlanResult> {
  const trimmed = requestText.trim();
  if (trimmed.length === 0) {
    return {
      ok: false,
      error: "Type what you want to monitor to get started.",
    };
  }
  if (trimmed.length > REQUEST_MAX_LENGTH) {
    return {
      ok: false,
      error: tooLong(trimmed, REQUEST_MAX_LENGTH, "Requests"),
    };
  }
  return planAndPersist(trimmed, undefined, options.persist ?? true);
}

export async function refineDashboard(
  requestText: string,
  instruction: string,
  previousPlan: unknown,
): Promise<PlanResult> {
  const trimmedInstruction = instruction.trim();
  if (trimmedInstruction.length === 0) {
    return { ok: false, error: "Type what you want to change." };
  }
  if (trimmedInstruction.length > REFINEMENT_MAX_LENGTH) {
    return {
      ok: false,
      error: tooLong(trimmedInstruction, REFINEMENT_MAX_LENGTH, "Changes"),
    };
  }

  // Parse, don't trust. The client is holding this plan and can return
  // anything; what comes back is a `DashboardPlan` because the schema said so,
  // not because of where it arrived from.
  const parsed = DashboardPlanSchema.safeParse(previousPlan);
  if (!parsed.success) {
    return {
      ok: false,
      error: "That dashboard can no longer be changed. Build a new one.",
    };
  }
  const base: DashboardPlan = parsed.data;

  return planAndPersist(requestText.trim().slice(0, REQUEST_MAX_LENGTH), {
    previousPlan: base,
    instruction: trimmedInstruction,
  });
}
