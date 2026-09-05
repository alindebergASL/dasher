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
  "What changed last month?",
  "Spending by category, quarterly",
  "Which lines are over budget?",
  "Show the biggest movers",
] as const;

const REFINEMENTS = [
  "Exclude salaries",
  "Quarterly",
  "Just the overview",
  "Show the last 3 months",
] as const;

function formatFileSize(bytes: number): string {
  if (bytes < 1000) return `${String(bytes)} B`;
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

type DisplayedSource =
  | { readonly kind: "sample" }
  | { readonly kind: "upload"; readonly name?: string };

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
  const [selectedFile, setSelectedFile] = useState<File | undefined>(undefined);
  const [displayedSource, setDisplayedSource] = useState<DisplayedSource>(
    initial.source?.kind === "upload" ? { kind: "upload" } : { kind: "sample" },
  );
  const [draggingFile, setDraggingFile] = useState(false);
  const [version, setVersion] = useState(0);
  const [pending, startTransition] = useTransition();
  const fileInput = useRef<HTMLInputElement>(null);
  const changeInput = useRef<HTMLInputElement>(null);

  const dashboard = result.dashboard;
  const plan = result.plan;

  function currentFile(): File | undefined {
    const file = selectedFile;
    return file !== undefined && file.size > 0 ? file : undefined;
  }

  function selectFile(file: File | undefined) {
    if (file === undefined || file.size === 0) return;
    setSelectedFile(file);
    setError(undefined);
  }

  function useSampleData() {
    setSelectedFile(undefined);
    if (fileInput.current !== null) fileInput.current.value = "";
  }

  function apply(
    next: PlanResult,
    nextRequest: string,
    sourceUsed: DisplayedSource,
  ) {
    if (!next.ok || next.dashboard === undefined) {
      setError(next.error ?? "That request could not be built.");
      return;
    }
    setResult(next);
    setDisplayedSource(sourceUsed);
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
    const file = currentFile();
    const sourceUsed: DisplayedSource =
      file === undefined
        ? { kind: "sample" }
        : { kind: "upload", name: file.name };
    form.set("request", text);
    setRequest(text);
    startTransition(async () => {
      apply(await buildDashboard(form), text, sourceUsed);
    });
  }

  function refine(instruction: string) {
    if (plan === undefined) return;
    const form = sourceForm();
    if (form === undefined) return;
    const file = currentFile();
    const sourceUsed: DisplayedSource =
      file === undefined
        ? { kind: "sample" }
        : { kind: "upload", name: file.name };
    form.set("request", activeRequest);
    form.set("plan", JSON.stringify(plan));
    form.set("instruction", instruction);
    setChange(instruction);
    startTransition(async () => {
      apply(await buildDashboard(form), activeRequest, sourceUsed);
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
        <header className="composer-heading">
          <div>
            <span className="composer-kicker">Dashboard workspace</span>
            <h2>Ask Dasher</h2>
            <p>Ask with the sample data, or bring a CSV of your own.</p>
          </div>
        </header>

        <div className="request-composer">
          <div className="request-compose-body">
            <label className="request-label" htmlFor="dashboard-request">
              What should this dashboard answer?
            </label>
            <textarea
              aria-describedby="dashboard-source-status"
              aria-label="What should this dashboard answer?"
              autoComplete="off"
              className="request-input request-prompt"
              id="dashboard-request"
              maxLength={REQUEST_MAX_LENGTH}
              name="request"
              onChange={(event) => setRequest(event.target.value)}
              placeholder="Where is the money going, and what changed?"
              rows={3}
              value={request}
            />
            <div className="request-examples">
              <span className="request-examples-label">Start with</span>
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
            <div className="composer-footer">
              <p
                aria-label="Planning status"
                className="composer-trust"
                role="status"
              >
                {result.usesModel
                  ? "AI arranges safe metadata. Trusted code computes every number."
                  : "Trusted code computes every number."}
                {(result.attempts ?? 1) > 1
                  ? " An unsafe first plan was rejected before rendering."
                  : ""}
              </p>
              <button
                className="request-submit"
                disabled={pending}
                type="submit"
              >
                {pending ? "Building…" : "Build dashboard"}
                <span aria-hidden="true">→</span>
              </button>
            </div>
          </div>

          <aside aria-label="Choose data source" className="request-source">
            <span className="request-label">Data source</span>
            <div
              className={`source-dropzone${draggingFile ? " source-dropzone-active" : ""}`}
              data-testid="source-dropzone"
              onDragEnter={(event) => {
                event.preventDefault();
                setDraggingFile(true);
              }}
              onDragLeave={(event) => {
                if (
                  !event.currentTarget.contains(
                    event.relatedTarget as Node | null,
                  )
                ) {
                  setDraggingFile(false);
                }
              }}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = "copy";
              }}
              onDrop={(event) => {
                event.preventDefault();
                setDraggingFile(false);
                selectFile(event.dataTransfer.files[0]);
              }}
            >
              <label className="source-picker" htmlFor="dashboard-file">
                <input
                  accept=".csv,text/csv,text/tab-separated-values"
                  aria-label="Choose a CSV data source"
                  className="upload-file"
                  id="dashboard-file"
                  name="file"
                  onChange={(event) => selectFile(event.target.files?.[0])}
                  ref={fileInput}
                  type="file"
                />
                <span aria-hidden="true" className="source-icon">
                  {selectedFile === undefined ? "+" : "✓"}
                </span>
                <span className="source-copy">
                  <strong>
                    {selectedFile === undefined
                      ? "Sample operating data"
                      : selectedFile.name}
                  </strong>
                  <span>
                    {selectedFile === undefined
                      ? "Eight months · ready to explore"
                      : `${formatFileSize(selectedFile.size)} · selected`}
                  </span>
                </span>
                <span className="source-action">
                  {selectedFile === undefined ? "Choose CSV" : "Replace"}
                </span>
              </label>
            </div>
            <div className="source-status-row">
              <p
                aria-atomic="true"
                aria-label="Data source"
                className="source-status"
                id="dashboard-source-status"
                role="status"
              >
                <span aria-hidden="true" className="source-status-dot" />
                {selectedFile === undefined
                  ? "Next build: sample data."
                  : `Next build: uploaded file ${selectedFile.name}.`}
              </p>
              {selectedFile === undefined ? null : (
                <button
                  className="source-reset"
                  onClick={useSampleData}
                  type="button"
                >
                  Use sample data
                </button>
              )}
            </div>
            <p className="source-current">
              Displayed dashboard:{" "}
              {displayedSource.kind === "sample"
                ? "sample data."
                : displayedSource.name === undefined
                  ? "uploaded data."
                  : `${displayedSource.name}.`}
            </p>
            <p className="source-hint">
              Files are sent to the server for validation. When signed in,
              uploads are stored as dashboard evidence.
            </p>
          </aside>
        </div>
        {error ? (
          <p className="request-error" role="alert">
            {error}
          </p>
        ) : null}
        <span aria-label="Dashboard update" className="sr-only" role="status">
          {pending
            ? "Building dashboard."
            : version === 0
              ? ""
              : `Dashboard updated for ${activeRequest}. Review the dataset interpretation before acting.`}
        </span>
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
