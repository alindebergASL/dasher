"use client";

import { useRef, useState, useTransition } from "react";

import { buildDashboard } from "@/app/actions";
import {
  REFINEMENT_MAX_LENGTH,
  REQUEST_MAX_LENGTH,
  UPLOAD_MAX_BYTES,
  type PlanResult,
} from "@/app/planning";

import { DashboardShell } from "./dashboard-shell";

const REQUESTS = [
  "Where is the money going, and what changed last month?",
  "Spending by category, quarterly",
  "Which lines are over budget?",
  "Largest transactions and the biggest movers",
] as const;

const REFINEMENTS = [
  "Exclude salaries",
  "Quarterly",
  "Just the overview",
  "Show the last 3 months",
] as const;

export function RequestWorkspace({
  initial,
  initialRequest,
}: {
  initial: PlanResult;
  initialRequest: string;
}) {
  const [result, setResult] = useState<PlanResult>(initial);
  const [request, setRequest] = useState(initialRequest);
  const [activeRequest, setActiveRequest] = useState(initialRequest);
  const [change, setChange] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [fileName, setFileName] = useState<string | undefined>(undefined);
  const [version, setVersion] = useState(0);
  const [pending, startTransition] = useTransition();
  const fileInput = useRef<HTMLInputElement>(null);
  const changeInput = useRef<HTMLInputElement>(null);

  const dashboard = result.dashboard;
  const plan = result.plan;

  function currentFile(): File | undefined {
    const file = fileInput.current?.files?.[0];
    return file !== undefined && file.size > 0 ? file : undefined;
  }

  function apply(next: PlanResult, nextRequest: string) {
    if (!next.ok || next.dashboard === undefined) {
      setError(next.error ?? "That request could not be built.");
      return;
    }
    setResult(next);
    setActiveRequest(nextRequest);
    setError(next.error);
    setChange("");
    setVersion((current) => current + 1);
  }

  function sourceForm(): FormData | undefined {
    const form = new FormData();
    const file = currentFile();
    if (file !== undefined) {
      if (file.size > UPLOAD_MAX_BYTES) {
        setError(
          `That file is bigger than the ${String(Math.floor(UPLOAD_MAX_BYTES / (1024 * 1024)))} MB this accepts.`,
        );
        return undefined;
      }
      form.set("file", file);
    } else {
      form.set("source", "sample");
    }
    return form;
  }

  function build(text: string) {
    const form = sourceForm();
    if (form === undefined) return;
    form.set("request", text);
    setRequest(text);
    startTransition(async () => {
      apply(await buildDashboard(form), text);
    });
  }

  function refine(instruction: string) {
    if (plan === undefined) return;
    const form = sourceForm();
    if (form === undefined) return;
    form.set("request", activeRequest);
    form.set("plan", JSON.stringify(plan));
    form.set("instruction", instruction);
    setChange(instruction);
    startTransition(async () => {
      apply(await buildDashboard(form), activeRequest);
    });
  }

  return (
    <div className="request-workspace">
      <form
        className="request-bar"
        onSubmit={(event) => {
          event.preventDefault();
          build(request);
        }}
      >
        <div className="request-source">
          <label className="request-label" htmlFor="dashboard-file">
            Your spreadsheet (CSV)
          </label>
          <input
            accept=".csv,text/csv,text/tab-separated-values"
            aria-label="Your spreadsheet (CSV)"
            className="upload-file"
            id="dashboard-file"
            name="file"
            onChange={(event) => {
              setFileName(event.target.files?.[0]?.name);
            }}
            ref={fileInput}
            type="file"
          />
          <p className="request-note">
            {fileName === undefined
              ? "No file chosen, so requests run against the sample: eight months of operating transactions."
              : `Building from ${fileName}. The file is read on the server and, when you are signed in, kept as the evidence behind the dashboard.`}
          </p>
        </div>
        <label className="request-label" htmlFor="dashboard-request">
          What do you want to see?
        </label>
        <div className="request-row">
          <input
            aria-label="What do you want to see?"
            autoComplete="off"
            className="request-input"
            id="dashboard-request"
            maxLength={REQUEST_MAX_LENGTH}
            name="request"
            onChange={(event) => setRequest(event.target.value)}
            placeholder="Where is the money going?"
            type="text"
            value={request}
          />
          <button className="request-submit" disabled={pending} type="submit">
            {pending ? "Building…" : "Build dashboard"}
          </button>
        </div>
        <div className="request-examples">
          <span className="request-examples-label">Try:</span>
          {REQUESTS.map((example) => (
            <button
              className="request-example"
              disabled={pending}
              key={example}
              onClick={() => build(example)}
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
        <p className="request-note" role="status">
          {result.usesModel
            ? "A planning model chose the layout from safe column metadata, never source values or totals."
            : "The built-in planner chose the layout."}{" "}
          Every number below is computed from the dataset.
          {(result.attempts ?? 1) > 1
            ? " The first plan was rejected by Dasher and corrected before anything rendered."
            : ""}{" "}
          <a className="request-permalink" href="/dashboards">
            Your dashboards
          </a>
        </p>
      </form>

      {result.interpretation === undefined ? null : (
        <section
          aria-label="Dataset interpretation"
          className="interpretation-strip"
        >
          <div className="interpretation-copy">
            <span className="interpretation-kicker">Dataset interpreted</span>
            <p>
              <strong>{result.interpretation.primaryMeasure}</strong> as the
              primary measure · <strong>{result.interpretation.period}</strong>{" "}
              as the period
              {result.interpretation.otherMeasures.length === 0
                ? ""
                : result.interpretation.otherMeasures.length === 1
                  ? ` · ${result.interpretation.otherMeasures[0]} as a supporting measure`
                  : ` · ${result.interpretation.otherMeasures.join(", ")} as supporting measures`}
              {result.interpretation.identifiers.length === 0
                ? ""
                : ` · ${result.interpretation.identifiers.join(", ")} as identifiers, codes, or ordinals`}
            </p>
          </div>
          <button
            className="interpretation-correct"
            onClick={() => changeInput.current?.focus()}
            type="button"
          >
            Correct interpretation
          </button>
        </section>
      )}

      {dashboard === undefined ? null : (
        <DashboardShell
          dashboard={dashboard}
          key={`${activeRequest}#${String(version)}`}
        />
      )}

      {plan === undefined ? null : (
        <form
          className="refine-bar"
          onSubmit={(event) => {
            event.preventDefault();
            refine(change);
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
              placeholder="Use Revenue as the primary measure"
              ref={changeInput}
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
                onClick={() => refine(example)}
                type="button"
              >
                {example}
              </button>
            ))}
          </div>
          {result.refinement === "already-satisfied" ? (
            <p className="request-note" role="status">
              The dashboard already looks like that, so nothing changed.
            </p>
          ) : null}
        </form>
      )}

      {result.dashboardId !== undefined ? (
        <p className="request-note" role="status">
          Saved.{" "}
          <a className="request-permalink" href={`/d/${result.dashboardId}`}>
            Open this dashboard by link
          </a>{" "}
          — it will still be here after a reload.
        </p>
      ) : null}
    </div>
  );
}
