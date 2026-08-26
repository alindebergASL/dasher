"use client";

import type { DashboardSpec } from "@dasher/dashboard-schema";
import type { DashboardPlan } from "@dasher/planner";
import { useState, useTransition } from "react";

import { planDashboard, refineDashboard } from "@/app/actions";
import {
  REFINEMENT_MAX_LENGTH,
  REQUEST_MAX_LENGTH,
  type PlanResult,
} from "@/app/planning";

import { DashboardShell } from "./dashboard-shell";
import { LedgerUpload } from "./ledger-upload";

const EXAMPLES = [
  "Create a live dashboard monitoring river gauges near Sacramento",
  "Air quality across Sacramento",
  "Current student enrollment at UC Riverside",
  "Operating spend by category",
  "Which gauges are rising fastest?",
  "How is the American river doing?",
] as const;

/**
 * One sentence per reason a dashboard cannot be changed.
 *
 * A table rather than a chain of conditionals, because the chain is how the
 * combined dashboard came to be described as an official snapshot: a new reason
 * that nobody added a branch for silently inherited the last `else`. Here a
 * reason without a sentence does not compile.
 */
const NO_REFINEMENT_SENTENCE: Readonly<
  Record<"official-snapshot" | "combined-sources" | "uploaded-file", string>
> = {
  "official-snapshot":
    "This official snapshot has no refinement path yet. Build a new dashboard to ask a different question.",
  "combined-sources":
    "This combined dashboard has no refinement path yet, because a change would have to say which of its two sources it means. Build a new dashboard to ask a different question.",
  "uploaded-file":
    "This dashboard was built from a file you uploaded, and changing it would mean reading that file again — which this cannot do yet. Upload it again with a different brief to ask something else.",
};

const REFINEMENTS = [
  "Drop the map",
  "Add the history chart",
  "Make it shorter",
  "Just the American river",
] as const;

export function RequestWorkspace({
  initialDashboard,
  initialPlan,
  initialRequest,
}: {
  initialDashboard: DashboardSpec;
  initialPlan: DashboardPlan;
  initialRequest: string;
}) {
  const [dashboard, setDashboard] = useState(initialDashboard);
  const [plan, setPlan] = useState<DashboardPlan | undefined>(initialPlan);
  const [request, setRequest] = useState(initialRequest);
  const [activeRequest, setActiveRequest] = useState(initialRequest);
  const [change, setChange] = useState("");
  const [version, setVersion] = useState(0);
  const [error, setError] = useState<string | undefined>(undefined);
  const [revised, setRevised] = useState(false);
  const [refinement, setRefinement] = useState<
    "not-understood" | "already-satisfied" | undefined
  >(undefined);
  const [savedId, setSavedId] = useState<string | undefined>(undefined);
  const [noRefinement, setNoRefinement] = useState<
    "official-snapshot" | "combined-sources" | "uploaded-file" | undefined
  >(undefined);
  const [pending, startTransition] = useTransition();

  function apply(result: PlanResult, nextRequest: string) {
    if (!result.ok || !result.dashboard) {
      setError(result.error ?? "That request could not be built.");
      setRefinement(undefined);
      return;
    }
    setDashboard(result.dashboard);
    setPlan(result.plan);
    setActiveRequest(nextRequest);
    // NOT unconditionally cleared. A dashboard can be built and still fail to
    // save, and `actions.ts` deliberately returns it with `ok: true` and an
    // error saying so. Clearing here discarded that message before render — the
    // "the page looked fine" failure the two domains were split to prevent, put
    // back by the component that displays them.
    setError(result.error);
    setRevised((result.attempts ?? 1) > 1);
    setRefinement(result.refinement);
    // A refinement returns no id: it produces a new version of a dashboard
    // that is not persisted by this slice, so keeping the previous link would
    // point at a dashboard the reader is no longer looking at.
    setSavedId(result.dashboardId);
    setNoRefinement(result.noRefinement);
    // Remounts the dashboard so a refinement visibly redraws. Keying on the
    // request alone would leave a refinement of the same request looking like
    // nothing happened.
    setVersion((current) => current + 1);
  }

  function submit(text: string) {
    setRequest(text);
    startTransition(async () => {
      apply(await planDashboard(text), text);
      setChange("");
    });
  }

  function submitChange(instruction: string) {
    if (plan === undefined) return;
    setChange(instruction);
    startTransition(async () => {
      apply(
        await refineDashboard(activeRequest, instruction, plan),
        activeRequest,
      );
    });
  }

  return (
    <div className="request-workspace">
      <form
        className="request-bar"
        onSubmit={(event) => {
          event.preventDefault();
          submit(request);
        }}
      >
        <label className="request-label" htmlFor="dashboard-request">
          What do you want to monitor?
        </label>
        <div className="request-row">
          <input
            autoComplete="off"
            className="request-input"
            id="dashboard-request"
            maxLength={REQUEST_MAX_LENGTH}
            name="request"
            onChange={(event) => setRequest(event.target.value)}
            placeholder="Create a live dashboard monitoring river gauges near Sacramento"
            type="text"
            value={request}
          />
          <button className="request-submit" disabled={pending} type="submit">
            {pending ? "Building…" : "Build dashboard"}
          </button>
        </div>

        <div className="request-examples">
          <span className="request-examples-label">Try:</span>
          {EXAMPLES.map((example) => (
            <button
              className="request-example"
              disabled={pending}
              key={example}
              onClick={() => submit(example)}
              type="button"
            >
              {example}
            </button>
          ))}
        </div>

        {error ? (
          <p className="request-error" role="alert">
            {error}
          </p>
        ) : null}

        <p className="request-note">
          Deterministic generation. Dasher used a bounded builder or planner for
          this request. Every number below is parsed or calculated from cited
          source data.
          {revised
            ? " Its first plan was rejected by Dasher and corrected before anything rendered."
            : ""}{" "}
          <a className="request-permalink" href="/dashboards">
            Your dashboards
          </a>
        </p>
      </form>

      {/*
        A SIBLING of the request form, not a child of it, and the difference is
        not cosmetic: a form inside a form is invalid HTML, the parser drops the
        inner one, and React's hydration then fails against a DOM that is
        missing an element it rendered. The whole tree stops being interactive.
        Nothing caught that except a real browser — jsdom builds the nested
        form quite happily, so the component tests passed while the page was
        dead.

        `apply` is the same function the typed path uses, so an uploaded
        dashboard reaches the shell, the saved link, and the no-refinement note
        through exactly one code path.
      */}
      <LedgerUpload disabled={pending} onBuilt={apply} />

      {plan === undefined ? (
        // Same missing plan, two different reasons, two different sentences.
        // Calling a river-and-air dashboard an "official snapshot" described a
        // product the reader was not looking at.
        <p className="request-note" role="status">
          {NO_REFINEMENT_SENTENCE[noRefinement ?? "official-snapshot"]}
        </p>
      ) : (
        <form
          className="refine-bar"
          onSubmit={(event) => {
            event.preventDefault();
            submitChange(change);
          }}
        >
          <label className="request-label" htmlFor="dashboard-change">
            Change this dashboard
          </label>
          <div className="request-row">
            <input
              autoComplete="off"
              className="request-input"
              id="dashboard-change"
              maxLength={REFINEMENT_MAX_LENGTH}
              name="change"
              onChange={(event) => setChange(event.target.value)}
              placeholder="Drop the map"
              type="text"
              value={change}
            />
            <button className="request-submit" disabled={pending} type="submit">
              {pending ? "Changing…" : "Apply change"}
            </button>
          </div>

          <div className="request-examples">
            <span className="request-examples-label">Try:</span>
            {REFINEMENTS.map((example) => (
              <button
                className="request-example"
                disabled={pending}
                key={example}
                onClick={() => submitChange(example)}
                type="button"
              >
                {example}
              </button>
            ))}
          </div>

          {refinement === "not-understood" ? (
            <p className="request-note" role="status">
              Dasher did not understand that change, so it left the dashboard as
              it was. Naming a section — the map, the table, the history chart —
              works better than describing a mood.
            </p>
          ) : null}
          {refinement === "already-satisfied" ? (
            <p className="request-note" role="status">
              The dashboard already looks like that, so nothing changed.
            </p>
          ) : null}
        </form>
      )}

      {savedId !== undefined ? (
        <p className="request-note" role="status">
          Saved.{" "}
          <a className="request-permalink" href={`/d/${savedId}`}>
            Open this dashboard by link
          </a>{" "}
          — it will still be here after a reload.
        </p>
      ) : null}

      <DashboardShell
        dashboard={dashboard}
        key={`${activeRequest}#${version}`}
      />
    </div>
  );
}
