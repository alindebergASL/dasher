"use client";

import { useEffect, useRef, useState } from "react";

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
  "Show the detail table",
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
  | {
      readonly kind: "upload";
      readonly name?: string;
      /** Local identity for one selected File object; never persisted. */
      readonly selectionId?: number;
    };

function sameSource(left: DisplayedSource, right: DisplayedSource): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "sample") return true;
  if (right.kind !== "upload") return false;
  if (left.selectionId !== undefined || right.selectionId !== undefined) {
    return left.selectionId === right.selectionId;
  }
  return left.name === right.name;
}

function sourceDescription(source: DisplayedSource): string {
  return source.kind === "sample"
    ? "sample data"
    : source.name === undefined
      ? "uploaded data"
      : source.name;
}

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
  const [selectedSourceId, setSelectedSourceId] = useState(0);
  const [displayedSource, setDisplayedSource] = useState<DisplayedSource>(
    initial.source?.kind === "upload" ? { kind: "upload" } : { kind: "sample" },
  );
  const [draggingFile, setDraggingFile] = useState(false);
  const [version, setVersion] = useState(0);
  const [composerExpanded, setComposerExpanded] = useState(true);
  const [pendingKind, setPendingKind] = useState<
    "primary" | "refinement" | undefined
  >(undefined);
  const pendingRef = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const questionInput = useRef<HTMLTextAreaElement>(null);
  const compactSummary = useRef<HTMLDivElement>(null);
  const focusQuestionOnExpand = useRef(false);
  const focusCompactOnCollapse = useRef(false);
  const changeInput = useRef<HTMLInputElement>(null);

  const dashboard = result.dashboard;
  const plan = result.plan;
  const pending = pendingKind !== undefined;
  const selectedSource: DisplayedSource =
    selectedFile === undefined
      ? { kind: "sample" }
      : {
          kind: "upload",
          name: selectedFile.name,
          selectionId: selectedSourceId,
        };
  const sourceWillChange = !sameSource(selectedSource, displayedSource);
  const replacingSameNamedUpload =
    sourceWillChange &&
    selectedSource.kind === "upload" &&
    displayedSource.kind === "upload" &&
    selectedSource.name !== undefined &&
    selectedSource.name === displayedSource.name;
  const sourceStatusMessage = replacingSameNamedUpload
    ? `Next build: a newly selected file named ${selectedSource.name}. Currently showing: the previous file with that name.`
    : sourceWillChange
      ? `Next build: ${sourceDescription(selectedSource)}. Currently showing: ${sourceDescription(displayedSource)}.`
      : `Using ${sourceDescription(selectedSource)}.`;
  const planningStatusMessage =
    (result.usesModel
      ? "AI arranges safe metadata. Deterministic calculations stay linked to source evidence."
      : "Deterministic calculations stay linked to source evidence.") +
    ((result.attempts ?? 1) > 1
      ? " An unsafe first plan was rejected before rendering."
      : "");

  useEffect(() => {
    if (composerExpanded && focusQuestionOnExpand.current) {
      focusQuestionOnExpand.current = false;
      questionInput.current?.focus();
    }
    if (!composerExpanded && focusCompactOnCollapse.current) {
      focusCompactOnCollapse.current = false;
      compactSummary.current?.focus();
    }
  }, [composerExpanded]);

  function currentFile(): File | undefined {
    const file = selectedFile;
    return file !== undefined && file.size > 0 ? file : undefined;
  }

  function selectFile(file: File | undefined) {
    if (pendingRef.current || file === undefined || file.size === 0) return;
    setSelectedFile(file);
    setSelectedSourceId((current) => current + 1);
    setError(undefined);
    setComposerExpanded(true);
  }

  function useSampleData() {
    if (pendingRef.current) return;
    setSelectedFile(undefined);
    setError(undefined);
    setComposerExpanded(true);
    if (fileInput.current !== null) fileInput.current.value = "";
  }

  function apply(
    next: PlanResult,
    nextRequest: string,
    sourceUsed: DisplayedSource,
    kind: "primary" | "refinement",
  ) {
    if (!next.ok || next.dashboard === undefined) {
      setError(next.error ?? "That request could not be built.");
      return;
    }
    setResult(next);
    setDisplayedSource(sourceUsed);
    setError(next.error);
    setChange("");
    setVersion((current) => current + 1);
    if (kind === "primary") {
      setActiveRequest(nextRequest);
      setRequest(nextRequest);
      focusCompactOnCollapse.current = true;
      setComposerExpanded(false);
    }
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
    if (pendingRef.current) return;
    const form = sourceForm();
    if (form === undefined) return;
    const file = currentFile();
    const sourceUsed: DisplayedSource =
      file === undefined
        ? { kind: "sample" }
        : {
            kind: "upload",
            name: file.name,
            selectionId: selectedSourceId,
          };
    form.set("request", text);
    setRequest(text);
    pendingRef.current = true;
    setPendingKind("primary");
    void (async () => {
      try {
        apply(await buildDashboard(form), text, sourceUsed, "primary");
      } finally {
        pendingRef.current = false;
        setPendingKind(undefined);
      }
    })();
  }

  function refine(instruction: string) {
    if (pendingRef.current || plan === undefined) return;
    const form = sourceForm();
    if (form === undefined) return;
    const file = currentFile();
    const sourceUsed: DisplayedSource =
      file === undefined
        ? { kind: "sample" }
        : {
            kind: "upload",
            name: file.name,
            selectionId: selectedSourceId,
          };
    form.set("request", activeRequest);
    form.set("plan", JSON.stringify(plan));
    form.set("instruction", instruction);
    setChange(instruction);
    pendingRef.current = true;
    setPendingKind("refinement");
    void (async () => {
      try {
        apply(
          await buildDashboard(form),
          activeRequest,
          sourceUsed,
          "refinement",
        );
      } finally {
        pendingRef.current = false;
        setPendingKind(undefined);
      }
    })();
  }

  return (
    <div className="request-workspace">
      <form
        className={`request-bar${composerExpanded ? "" : " request-bar-compact"}`}
        onSubmit={(event) => {
          event.preventDefault();
          build(request);
        }}
      >
        {composerExpanded ? (
          <header className="composer-heading">
            <div>
              <span className="composer-kicker">Dashboard workspace</span>
              <h2>Ask Dasher</h2>
              <p>
                Ask with the sample data, or bring a spreadsheet of your own.
              </p>
            </div>
          </header>
        ) : null}

        <div
          aria-label={
            composerExpanded ? undefined : "Current Ask Dasher question"
          }
          className={`request-composer${composerExpanded ? "" : " request-compact"}`}
          ref={composerExpanded ? undefined : compactSummary}
          role={composerExpanded ? undefined : "region"}
          tabIndex={composerExpanded ? undefined : -1}
        >
          {composerExpanded ? (
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
                disabled={pending}
                onChange={(event) => {
                  if (!pendingRef.current) setRequest(event.target.value);
                }}
                placeholder="Where is the money going, and what changed?"
                ref={questionInput}
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
                  {planningStatusMessage}
                </p>
                <button
                  className="request-submit"
                  disabled={pending}
                  type="submit"
                >
                  {pendingKind === "primary" ? "Building…" : "Build dashboard"}
                  <span aria-hidden="true">→</span>
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="request-compact-copy">
                <span className="composer-kicker">Current question</span>
                <p className="request-compact-question">{activeRequest}</p>
                <p className="source-current">
                  Uses {sourceDescription(displayedSource)} · evidence-backed
                </p>
              </div>
              <button
                aria-label="Edit question"
                className="request-edit"
                disabled={pending}
                onClick={() => {
                  if (pendingRef.current) return;
                  focusQuestionOnExpand.current = true;
                  setComposerExpanded(true);
                }}
                type="button"
              >
                <span className="request-edit-wide">Edit question</span>
                <span aria-hidden="true" className="request-edit-short">
                  Edit
                </span>
              </button>
              <p aria-label="Planning status" className="sr-only" role="status">
                {planningStatusMessage}
              </p>
            </>
          )}

          <aside
            aria-label="Choose data source"
            className={`request-source${composerExpanded ? "" : " request-source-compact"}`}
          >
            <span className={composerExpanded ? "request-label" : "sr-only"}>
              Data source
            </span>
            <div
              aria-disabled={pending}
              className={`source-dropzone${draggingFile ? " source-dropzone-active" : ""}`}
              data-testid="source-dropzone"
              onDragEnter={(event) => {
                event.preventDefault();
                if (pendingRef.current) return;
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
                event.dataTransfer.dropEffect = pendingRef.current
                  ? "none"
                  : "copy";
              }}
              onDrop={(event) => {
                event.preventDefault();
                setDraggingFile(false);
                if (pendingRef.current) return;
                selectFile(event.dataTransfer.files[0]);
              }}
            >
              <label className="source-picker" htmlFor="dashboard-file">
                <input
                  accept=".csv,.xlsx,text/csv,text/tab-separated-values,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                  aria-label="Choose a spreadsheet or CSV data source"
                  className="upload-file"
                  disabled={pending}
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
                    {!composerExpanded
                      ? "Change source"
                      : selectedFile === undefined
                        ? "Sample data"
                        : selectedFile.name}
                  </strong>
                  <span>
                    {selectedFile === undefined
                      ? "Eight months · ready to explore"
                      : `${formatFileSize(selectedFile.size)} · selected`}
                  </span>
                </span>
                <span className="source-action">
                  <span className="source-action-wide">
                    {selectedFile === undefined ? "Choose file" : "Replace"}
                  </span>
                  <span aria-hidden="true" className="source-action-short">
                    File
                  </span>
                </span>
              </label>
            </div>
            <div className="source-status-row">
              <p
                aria-atomic="true"
                aria-label="Data source"
                className={sourceWillChange ? "source-status" : "sr-only"}
                id="dashboard-source-status"
                role="status"
              >
                {sourceWillChange ? (
                  <span aria-hidden="true" className="source-status-dot" />
                ) : null}
                {sourceStatusMessage}
              </p>
              {selectedFile === undefined ? null : (
                <button
                  className="source-reset"
                  disabled={pending}
                  onClick={useSampleData}
                  type="button"
                >
                  Use sample data
                </button>
              )}
            </div>
            {composerExpanded ? (
              <p className="source-hint">
                Files are sent to the server for validation. When signed in,
                uploads are stored as dashboard evidence.
              </p>
            ) : null}
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
            disabled={pending}
            onClick={() => {
              if (!pendingRef.current) changeInput.current?.focus();
            }}
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
              disabled={pending}
              onChange={(event) => {
                if (!pendingRef.current) setChange(event.target.value);
              }}
              placeholder="Describe one change"
              ref={changeInput}
              type="text"
              value={change}
            />
            <button className="request-submit" disabled={pending} type="submit">
              {pendingKind === "refinement" ? "Changing…" : "Apply change"}
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
