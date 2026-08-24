"use server";

import { randomUUID } from "node:crypto";

import {
  DashboardPlanSchema,
  isUninterpretable,
  PlanRejected,
  readRefinementIntent,
  compileLedgerPlan,
  DETERMINISTIC_LEDGER_PLANNER,
  planLedgerDashboard,
  runPlanner,
  type DashboardPlan,
  type PlannerRunOptions,
  type PlanningProvider,
} from "@dasher/planner";
import { withDashboardRepository } from "@dasher/control-plane";
import {
  canonicalSpecBytes,
  composeDashboards,
  DashboardCompositionError,
  type AbsentSource,
  type CompositionMember,
  type DashboardSpec,
} from "@dasher/dashboard-schema";
import {
  buildUcrEnrollmentDashboard,
  EnrollmentSnapshotSchema,
} from "@dasher/enrollment-domain";
import { LedgerSnapshotSchema } from "@dasher/ledger-domain";

import ledgerSnapshot from "../../../fixtures/ledger/operating-spend.json";
import ucrEnrollmentSnapshot from "../../../fixtures/ucr/campus-facts-2025.snapshot.json";
import { getPool, isPersistenceConfigured } from "./database";
import {
  classifyRequest,
  type DomainDecision,
  type DomainEntry,
} from "./domains";
import {
  loadDomainSnapshot,
  SourceUnavailableError,
  type DomainSnapshot,
  type SourceMode,
} from "./source-runtime";
import { combinedProvenance, type PlannerProvenance } from "./provenance";
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
  provenance: { provider: string; model: string },
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
        provider: provenance.provider,
        model: provenance.model,
        canonicalSpecBytes: canonicalSpecBytes(dashboard),
        requestId: randomUUID(),
        deploymentRevision: process.env["DASHER_DEPLOYMENT_REVISION"] ?? "dev",
      }),
  );

  return saved.dashboardId;
}

/**
 * A plan, plus the planners that actually produced it.
 *
 * The second half exists because the first is not enough to say who built the
 * dashboard. A combined request names two domains; a combined dashboard may be
 * built from one of them, when the other source is down. Deriving the record
 * from the REQUEST rather than from what ran meant a partial dashboard was
 * persisted as the work of a planner that never executed — the same defect
 * `provenanceOf` was introduced to remove, one layer up, and introduced by the
 * same reflex: reading a fact off the thing beside the work instead of off the
 * work.
 *
 * `planners` is built in the same expression that runs each planner, so it
 * cannot be a second channel that drifts from the first.
 */
interface Planned {
  readonly result: PlanResult;
  readonly planners: readonly PlannerIdentity[];
}

type PlannerIdentity = Pick<PlanningProvider, "id" | "usesModel">;

/** A refusal, or a path where no planner runs. */
function planless(result: PlanResult): Planned {
  return { result, planners: [] };
}

/**
 * Which planner to name in the persisted record.
 *
 * Every branch that runs a planner asks the provider that actually ran rather
 * than restating a literal beside it. Enrollment is the single exception, and
 * it is one on purpose: no planner runs there at all — a builder reads an
 * official snapshot and compiles it directly — so naming the snapshot's own
 * source is the true answer rather than a stand-in for a missing one.
 *
 * The ledger is a known source too, but a PLANNED one, so it answers from the
 * list like the sensor branches do. Naming it with a literal would have been
 * correct today and wrong on the day its planner changes — which is the whole
 * failure this function was rewritten to stop.
 */
function plannerProvenance(
  decision: DomainDecision,
  planners: readonly PlannerIdentity[],
): PlannerProvenance {
  if (
    decision.kind === "known-source" &&
    decision.source !== "operating-ledger"
  ) {
    return {
      provider: "ucr-institutional-research",
      model: "deterministic-enrollment-v1",
    };
  }
  return combinedProvenance(planners);
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
  const decision = classifyRequest(requestText);
  const planned = await plan(requestText, decision, refine);
  const result = planned.result;
  if (
    !persistThis ||
    !result.ok ||
    result.dashboard === undefined ||
    refine !== undefined
  ) {
    // Only fresh generations get a durable identity in this slice. A refinement
    // produces a new version of a dashboard already on screen, and versioning
    // on refine needs the head revision it saw — the update path, not this one.
    return result;
  }

  try {
    const dashboardId = await persist(
      requestText,
      result.dashboard,
      result.dashboard.title,
      plannerProvenance(decision, planned.planners),
    );
    return dashboardId === undefined ? result : { ...result, dashboardId };
  } catch {
    // The dashboard stands; only its durability failed. Saying so is the point
    // — a persistence slice whose failure mode is "the page looked fine" would
    // be indistinguishable from not having built it.
    return {
      ...result,
      error: "This dashboard was built but could not be saved.",
    };
  }
}

/**
 * How a domain names itself to a reader: "river" -> "River", "air-quality" ->
 * "Air quality". The catalog's label is a routing word; this is the one that
 * appears in front of a person, and every attributed line in a combined
 * dashboard is built from it.
 */
function readerLabel(domain: DomainEntry): string {
  const spaced = domain.label.replaceAll("-", " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * How a snapshot's origin becomes the badge a reader sees.
 *
 * `SourceMode` is the runtime's word ("fixture" or "live"); `dataMode` is the
 * contract's ("demo" or "live"). They are deliberately different vocabularies —
 * one is about where bytes were fetched from, the other about what a reader
 * should believe — and this is the single place they are joined. Before this,
 * every builder wrote `dataMode: "demo"` as a literal, so a genuinely
 * live-sourced dashboard still badged itself "Demo dashboard" and the badge
 * carried no information at all.
 */
function dataModeOf(snapshot: { readonly mode: SourceMode }): "demo" | "live" {
  return snapshot.mode === "live" ? "live" : "demo";
}

/**
 * One request, several trusted sources, one dashboard.
 *
 * The shape here is the whole point of the slice: every source is loaded
 * independently and in parallel, each is compiled by ITS OWN parser,
 * computation policy, vocabulary and thresholds through the same planner the
 * single-source path uses, and only the finished specs meet — in
 * `composeDashboards`, which arranges and attributes but never computes. There
 * is no place in this function where one domain's rule could reach another's
 * readings, and that is a structural property rather than a convention.
 *
 * IT DEGRADES PER SOURCE, AND SAYS SO. This refused as a unit when it shipped:
 * one source down refused the whole request. That was truthful and it was too
 * blunt — it threw away a working river dashboard over a fault in the air
 * source, and it does so more often the more sources a request names.
 *
 * What made the unit refusal defensible was the alternative it was compared
 * against: a dashboard titled for two subjects that silently contains one,
 * which answers a question the reader did not ask while looking like it
 * answered the one they did. That is still forbidden. The third option is the
 * one taken here — show what loaded and NAME what did not — and it holds only
 * if three things are true together:
 *
 * - the title names the subjects that are actually on the page,
 * - the absence is attributed beside the sources that did load, which is
 *   `composeDashboards`' job rather than this one's, and
 * - all of it lives in the spec, so a saved partial still says so when it is
 *   reopened months later with no memory of the request.
 *
 * Nothing loading at all is still a refusal. A page of nothing but absences is
 * a refusal wearing a dashboard's clothes.
 */
interface LoadedSource {
  readonly domain: DomainEntry;
  readonly snapshot: DomainSnapshot;
}

/**
 * Every requested source, attempted in parallel, with an outage recorded
 * rather than thrown.
 *
 * The domain travels WITH its result. The previous version loaded through
 * `Promise.allSettled` and matched results back to domains by array index,
 * which is correct and is correct only for as long as nobody filters, sorts or
 * short-circuits the list in between. Pairing at the point of the attempt makes
 * the correspondence unbreakable rather than merely currently unbroken.
 *
 * Only a `SourceUnavailableError` becomes an absence. Anything else is a real
 * fault and propagates: a bug in a parser must not be reported to a reader as
 * an upstream having a bad minute.
 */
async function loadSources(
  domains: readonly DomainEntry[],
): Promise<readonly (LoadedSource | { readonly domain: DomainEntry })[]> {
  return Promise.all(
    domains.map(async (domain) => {
      try {
        return { domain, snapshot: await loadDomainSnapshot(domain.key) };
      } catch (error) {
        if (error instanceof SourceUnavailableError) return { domain };
        throw error;
      }
    }),
  );
}

function didLoad(
  attempt: LoadedSource | { readonly domain: DomainEntry },
): attempt is LoadedSource {
  return "snapshot" in attempt;
}

async function planCombined(
  requestText: string,
  domains: readonly [DomainEntry, DomainEntry],
): Promise<Planned> {
  const attempts = await loadSources(domains);
  const present = attempts.filter(didLoad);

  if (present.length === 0) {
    // Nothing loaded, so there is no dashboard to be partial about. This is the
    // same refusal the single-source path gives, for the same reason.
    return planless({
      ok: false,
      error: `Live ${domains.map((domain) => domain.label).join(" and ")} data is temporarily unavailable; try again.`,
    });
  }

  const shown = present.map((entry) => readerLabel(entry.domain));
  const absent: AbsentSource[] = attempts
    .filter((attempt) => !didLoad(attempt))
    .map((entry) => ({
      key: entry.domain.key,
      label: readerLabel(entry.domain),
    }));

  try {
    // IN REQUEST ORDER, absences included. `attempts` preserves the order the
    // router produced, and mapping it — rather than planning the loaded sources
    // and appending the rest — is what keeps a missing first subject first on
    // the page. Partitioning here was the caller's half of a defect the
    // composer's separate `absent` list made unavoidable: a reader who asked
    // for river and air quality with the river down got a dashboard whose every
    // attributed line began "Air quality:".
    // Each entry carries the member AND the planner that produced it, from the
    // same expression, so "who planned this" cannot drift from "what is on the
    // page". An absent source contributes a member and no planner, which is
    // exactly the distinction the persisted record needs.
    const built = await Promise.all(
      attempts.map(async (attempt) => {
        if (!didLoad(attempt)) {
          return {
            member: {
              key: attempt.domain.key,
              label: readerLabel(attempt.domain),
            } satisfies CompositionMember,
            planner: undefined,
          };
        }
        const run = await runPlanner({
          requestText,
          gauges: attempt.snapshot.stations,
          provider: attempt.domain.provider,
          asOf: attempt.snapshot.asOf,
          thresholds: attempt.domain.thresholds,
          computation: attempt.domain.computation,
          words: attempt.domain.words,
          dataMode: dataModeOf(attempt.snapshot),
        });
        return {
          member: {
            key: attempt.domain.key,
            label: readerLabel(attempt.domain),
            dashboard: run.dashboard,
          } satisfies CompositionMember,
          planner: attempt.domain.provider,
        };
      }),
    );
    const members: CompositionMember[] = built.map((one) => one.member);
    const planners = built
      .map((one) => one.planner)
      .filter((planner) => planner !== undefined);

    return {
      planners,
      result: {
        ok: true,
        dashboard: composeDashboards(members, {
          id: `combined-${domains.map((domain) => domain.key).join("-")}-conditions`,
          // THE TITLE NAMES WHAT IS ON THE PAGE. A partial that kept the whole
          // request's title would be the silent partial with extra steps: the
          // one line a reader reads before anything else would still promise a
          // subject the page does not contain.
          title: composedTitle(shown, absent),
          audience: `Readers tracking ${domains.map((domain) => domain.label).join(" and ")} together`,
          notice: composedNotice(shown, absent),
        }),
        attempts: 1,
        noRefinement: "combined-sources",
      },
    };
  } catch (error) {
    if (error instanceof PlanRejected) {
      return planless({
        ok: false,
        error:
          `Dasher could not build a dashboard it could stand behind for that request. ${error.findings[0]?.message ?? ""}`.trim(),
      });
    }
    if (error instanceof DashboardCompositionError) {
      // Every source that loaded built; the SET is what could not be shown
      // honestly — colliding namespaces, a mismatched data mode, or dashboards
      // that do not fit inside one contract budget. "Try rewording it" was the
      // message here before, and it is advice that cannot work: no phrasing
      // makes several dashboards fit in one. The single-source path is the
      // thing that will actually succeed, so that is what the reader is
      // offered.
      const subjects = domains
        .map((domain) => domain.label.replaceAll("-", " "))
        .join(" or ");
      return planless({
        ok: false,
        error: `Dasher built what it could for that request but could not combine the results into one dashboard it could stand behind. Ask for ${subjects} on its own.`,
      });
    }
    return planless({
      ok: false,
      error: "Something went wrong building that dashboard. Try rewording it.",
    });
  }
}

/**
 * What is on the page, then what is not.
 *
 * DELIBERATELY NOT COMPOSITION ORDER, unlike every attributed line. A title is
 * one statement rather than a sequence of voices, and its two halves mean
 * different things: the first says what the reader is getting, the second says
 * what they are not. Leading with the absence — "River unavailable — Air
 * quality" — leads with the bad news about a dashboard that does have something
 * to show. Within each half the request's order is kept.
 *
 * Worth stating because it now visibly disagrees with the freshness label,
 * which reads "River: unavailable · Air quality: …" for the same request. That
 * is the intended difference, not the ordering defect that produced it.
 */
function composedTitle(
  shown: readonly string[],
  absent: readonly AbsentSource[],
): string {
  const subjects = shown.join(" and ");
  if (absent.length === 0) return `${subjects} — combined conditions`;
  return `${subjects} — ${absent.map((entry) => entry.label).join(" and ")} unavailable`;
}

/**
 * The footer sentence, which is the one place the absence is stated in full.
 *
 * It renders on EVERY page, unlike the executive brief, which appears on the
 * first one. That is why the complete statement lives here rather than only in
 * the brief: a reader who lands on page three still gets told.
 */
function composedNotice(
  shown: readonly string[],
  absent: readonly AbsentSource[],
): string {
  const separately = `Each source keeps its own readings, thresholds, and wording, and no value on this page was calculated using another subject's rules.`;
  if (absent.length === 0) {
    return `${shown.join(" and ")} were built separately and are shown side by side. ${separately} Freshness is reported for the whole page: this dashboard is only as current as its least current source.`;
  }
  const names = absent.map((entry) => entry.label).join(" and ");
  return `${names} could not be loaded when this dashboard was built, and nothing here was substituted in its place — the sections below are ${shown.join(" and ")} only. ${separately} This dashboard is marked partial rather than current, and stays that way if it is saved and reopened.`;
}

async function plan(
  requestText: string,
  decision: DomainDecision,
  refine?: PlannerRunOptions["refine"],
): Promise<Planned> {
  // Deterministic routing, closed on failure. Nothing falls back to the river,
  // and a known official snapshot is not forced through the sensor compiler.
  if (decision.kind === "unsupported") {
    return planless({
      ok: false,
      error:
        "Dasher currently builds dashboards for river conditions, air quality, and UC Riverside enrollment. Try naming one of those subjects.",
    });
  }
  if (decision.kind === "ambiguous") {
    return planless({
      ok: false,
      error:
        "That asks about more than one supported subject. Ask for one dashboard at a time, and you can build the other one next.",
    });
  }
  if (decision.kind === "domains") {
    if (refine !== undefined) {
      return planless({
        ok: false,
        error:
          "A combined dashboard cannot be refined yet. Build a new one instead.",
      });
    }
    return planCombined(requestText, decision.domains);
  }
  if (decision.kind === "known-source") {
    if (refine !== undefined) {
      return planless({
        ok: false,
        error:
          "This snapshot cannot be refined yet. Build a new dashboard instead.",
      });
    }
    if (decision.source === "operating-ledger") {
      // The second PLANNED source, and the first that is not a station. It
      // takes the same route the river does — a plan, checked against the
      // snapshot that exists, compiled by trusted code, validated by the
      // contract — rather than the route enrollment takes, which is a builder
      // writing a finished `DashboardSpec` literal.
      try {
        const snapshot = LedgerSnapshotSchema.parse(ledgerSnapshot);
        return {
          result: {
            ok: true,
            dashboard: compileLedgerPlan(
              planLedgerDashboard(
                requestText,
                snapshot.lines.map((line) => line.id),
              ),
              snapshot,
              {
                asOf: new Date().toISOString(),
                planner: DETERMINISTIC_LEDGER_PLANNER,
              },
            ),
            attempts: 1,
            noRefinement: "official-snapshot",
          },
          // Named from the planner that just ran, not from a literal beside
          // it. The compile call above is the same expression, so the two
          // cannot drift.
          planners: [DETERMINISTIC_LEDGER_PLANNER],
        };
      } catch {
        return planless({
          ok: false,
          error: "The operating ledger snapshot could not be verified.",
        });
      }
    }
    try {
      const snapshot = EnrollmentSnapshotSchema.parse(ucrEnrollmentSnapshot);
      // No planner runs here at all, which is why `planners` is empty and why
      // `plannerProvenance` answers this case from the snapshot rather than
      // from the list.
      return planless({
        ok: true,
        dashboard: buildUcrEnrollmentDashboard(snapshot),
        attempts: 1,
        noRefinement: "official-snapshot",
      });
    } catch {
      return planless({
        ok: false,
        error:
          "The official UC Riverside enrollment snapshot could not be verified.",
      });
    }
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
      return planless({
        ok: false,
        error: `Live ${domain.label} data is temporarily unavailable; try again.`,
      });
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
      dataMode: dataModeOf(snapshot),
      ...(refine === undefined ? {} : { refine }),
    });
    const same =
      refine !== undefined &&
      JSON.stringify(run.plan) === JSON.stringify(refine.previousPlan);
    return {
      planners: [domain.provider],
      result: {
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
      },
    };
  } catch (error) {
    if (error instanceof PlanRejected) {
      return planless({
        ok: false,
        error:
          `Dasher could not build a dashboard it could stand behind for that request. ${error.findings[0]?.message ?? ""}`.trim(),
      });
    }
    return planless({
      ok: false,
      error: "Something went wrong building that dashboard. Try rewording it.",
    });
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
