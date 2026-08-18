"use client";

import type { DashboardSpec, Evidence } from "@dasher/dashboard-schema";
import { useMemo, useState } from "react";

import { ArchitectureDialog } from "./architecture-dialog";
import { ComponentRenderer } from "./component-renderer";
import { useModalFocus } from "./use-modal-focus";

function EvidenceDrawer({
  evidence,
  onClose,
}: {
  evidence: Evidence[];
  onClose: () => void;
}) {
  const { closeButtonRef, containerRef } = useModalFocus<HTMLElement>(onClose);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <aside
        aria-label="Sources and evidence"
        aria-modal="true"
        className="modal evidence-modal"
        ref={containerRef}
        role="dialog"
      >
        <div className="modal-heading">
          <div>
            <span className="eyebrow">Evidence</span>
            <h2>Why Dasher says this</h2>
          </div>
          <button
            aria-label="Close evidence"
            className="icon-button"
            onClick={onClose}
            ref={closeButtonRef}
            type="button"
          >
            ×
          </button>
        </div>
        <div className="evidence-list">
          {evidence.map((item) => (
            <article key={item.id}>
              <div>
                <span className={`evidence-kind kind-${item.kind}`}>
                  {item.kind}
                </span>
                <span className="confidence">{item.confidence} confidence</span>
              </div>
              <h3>{item.label}</h3>
              <p>{item.detail}</p>
              <small>
                {item.observedAt
                  ? `Observed ${new Date(item.observedAt).toLocaleString("en-US", { timeZone: "UTC" })} UTC · `
                  : ""}
                Retrieved{" "}
                {new Date(item.retrievedAt).toLocaleString("en-US", {
                  timeZone: "UTC",
                })}{" "}
                UTC
              </small>
              {item.sourceUrl ? (
                <a
                  href={item.sourceUrl}
                  rel="noreferrer noopener"
                  target="_blank"
                >
                  Open {item.sourceName} source ↗
                </a>
              ) : (
                <span>{item.sourceName}</span>
              )}
            </article>
          ))}
        </div>
      </aside>
    </div>
  );
}

const usefulnessOptions = ["1", "2", "3", "4", "5"] as const;
const needOptions = [
  "More historical comparison",
  "Clearer alert thresholds",
  "Named owner or handoff",
  "More local impact context",
  "Export or sharing workflow",
  "Other sanitized aggregate need",
] as const;

type Usefulness = (typeof usefulnessOptions)[number] | "";
type NeedCategory = (typeof needOptions)[number] | "";
type FeedbackIssue = "wrong" | "unclear" | "missing-context";
type EvidenceTaskTarget = "changed" | "next-action";
type EvidenceTaskStatus = "idle" | "armed" | "active" | "complete";

interface SessionTelemetry {
  evidenceOpens: number;
  nextActionReviewed: boolean;
  evidenceTaskTarget: EvidenceTaskTarget | "";
  evidenceTaskStatus: EvidenceTaskStatus;
  evidenceTaskInteractions: number;
  usefulness: Usefulness;
  issues: FeedbackIssue[];
  needCategory: NeedCategory;
}

function SessionFeedbackDialog({
  telemetry,
  onClose,
  onUsefulness,
  onIssue,
  onNeedCategory,
  onEvidenceTaskTarget,
  onStartEvidenceTask,
}: {
  telemetry: SessionTelemetry;
  onClose: () => void;
  onUsefulness: (value: Usefulness) => void;
  onIssue: (value: FeedbackIssue, checked: boolean) => void;
  onNeedCategory: (value: NeedCategory) => void;
  onEvidenceTaskTarget: (value: EvidenceTaskTarget | "") => void;
  onStartEvidenceTask: () => void;
}) {
  const { closeButtonRef, containerRef } = useModalFocus<HTMLElement>(onClose);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        aria-label="Session feedback"
        aria-modal="true"
        className="modal feedback-modal"
        ref={containerRef}
        role="dialog"
      >
        <div className="modal-heading">
          <div>
            <span className="eyebrow">Not saved</span>
            <h2>Session feedback</h2>
          </div>
          <button
            aria-label="Close session feedback"
            className="icon-button"
            onClick={onClose}
            ref={closeButtonRef}
            type="button"
          >
            ×
          </button>
        </div>
        <p className="feedback-boundary">
          These bounded answers stay only in this browser tab memory and are
          erased when the page reloads. Do not enter names or sensitive data.
        </p>
        <dl className="session-counters">
          <div>
            <dt>Evidence opens</dt>
            <dd>
              <output aria-label="Evidence opens this session">
                {telemetry.evidenceOpens}
              </output>
            </dd>
          </div>
          <div>
            <dt>Next action reviewed</dt>
            <dd>
              <output aria-label="Next action reviewed this session">
                {telemetry.nextActionReviewed ? "Yes" : "No"}
              </output>
            </dd>
          </div>
          <div>
            <dt>Evidence task interactions</dt>
            <dd>
              <output aria-label="Evidence task interactions">
                {telemetry.evidenceTaskInteractions}
              </output>
            </dd>
          </div>
          <div>
            <dt>Evidence task status</dt>
            <dd>
              <output aria-label="Evidence task status">
                {telemetry.evidenceTaskStatus === "idle"
                  ? "Not started"
                  : telemetry.evidenceTaskStatus === "armed"
                    ? "Starts when this dialog closes"
                    : telemetry.evidenceTaskStatus === "active"
                      ? "Counting"
                      : "Complete"}
              </output>
            </dd>
          </div>
        </dl>
        <div className="evidence-task-controls">
          <label>
            Requested evidence
            <select
              aria-label="Requested evidence"
              disabled={
                telemetry.evidenceTaskStatus === "armed" ||
                telemetry.evidenceTaskStatus === "active"
              }
              onChange={(event) =>
                onEvidenceTaskTarget(
                  event.target.value as EvidenceTaskTarget | "",
                )
              }
              value={telemetry.evidenceTaskTarget}
            >
              <option value="">Select one</option>
              <option value="changed">Changed</option>
              <option value="next-action">Next safe action</option>
            </select>
          </label>
          <button
            disabled={
              telemetry.evidenceTaskTarget === "" ||
              telemetry.evidenceTaskStatus === "active"
            }
            onClick={onStartEvidenceTask}
            type="button"
          >
            {telemetry.evidenceTaskStatus === "complete"
              ? "Restart evidence task"
              : telemetry.evidenceTaskStatus === "armed"
                ? "Task armed"
                : telemetry.evidenceTaskStatus === "active"
                  ? "Counting in progress"
                  : "Start evidence task"}
          </button>
          <small>
            Counting begins after this dialog closes and stops only when the
            requested evidence opens. Wrong activations remain in the count.
          </small>
        </div>
        <fieldset>
          <legend>Usefulness rating</legend>
          <div className="bounded-options usefulness-options">
            {usefulnessOptions.map((value) => (
              <label key={value}>
                <input
                  checked={telemetry.usefulness === value}
                  name="usefulness"
                  onChange={() => onUsefulness(value)}
                  type="radio"
                />
                {value}
              </label>
            ))}
          </div>
          <small>1 = not useful · 5 = very useful</small>
        </fieldset>
        <fieldset>
          <legend>What was wrong or unclear?</legend>
          <div className="bounded-options issue-options">
            {[
              ["wrong", "Wrong"],
              ["unclear", "Unclear"],
              ["missing-context", "Missing context"],
            ].map(([value, label]) => (
              <label key={value}>
                <input
                  checked={telemetry.issues.includes(value as FeedbackIssue)}
                  onChange={(event) =>
                    onIssue(value as FeedbackIssue, event.target.checked)
                  }
                  type="checkbox"
                />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="need-category">
          One missing information or workflow need
          <select
            aria-label="Missing information or workflow need"
            onChange={(event) =>
              onNeedCategory(event.target.value as NeedCategory)
            }
            value={telemetry.needCategory}
          >
            <option value="">Select one</option>
            {needOptions.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
      </section>
    </div>
  );
}

function ExecutiveBrief({
  dashboard,
  onEvidence,
}: {
  dashboard: Extract<DashboardSpec, { schemaVersion: "1.2" }>;
  onEvidence: (
    ids: string[],
    recordsNextAction?: boolean,
    evidenceTaskTarget?: EvidenceTaskTarget,
  ) => void;
}) {
  const items = [
    {
      label: "Known",
      ...dashboard.executiveBrief.known,
    },
    {
      label: "Changed",
      ...dashboard.executiveBrief.changed,
    },
    {
      label: "Important",
      ...dashboard.executiveBrief.important,
    },
    {
      label: "Next safe action",
      statementTypes: ["recommended"],
      headline: dashboard.nextAction.title,
      detail: dashboard.nextAction.detail,
      evidenceIds: dashboard.nextAction.evidenceIds,
    },
  ];

  return (
    <section
      aria-labelledby="executive-brief-heading"
      className="executive-brief"
    >
      <div className="executive-brief-heading">
        <span className="eyebrow">Decision view</span>
        <h2 id="executive-brief-heading">Executive brief</h2>
      </div>
      <ol className="executive-brief-list">
        {items.map((item) => (
          <li
            className={`executive-brief-item brief-${item.label.toLowerCase().replaceAll(" ", "-")}`}
            key={item.label}
          >
            <span className="executive-brief-label">{item.label}</span>
            <span className="executive-statement-types">
              {item.statementTypes
                .map((value) => value[0]!.toUpperCase() + value.slice(1))
                .join(" · ")}
            </span>
            <h3>{item.headline}</h3>
            <p>{item.detail}</p>
            <button
              aria-label={`Evidence for ${item.label}`}
              className="executive-brief-evidence"
              onClick={() =>
                onEvidence(
                  item.evidenceIds,
                  item.label === "Next safe action",
                  item.label === "Changed"
                    ? "changed"
                    : item.label === "Next safe action"
                      ? "next-action"
                      : undefined,
                )
              }
              type="button"
            >
              View evidence
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function DashboardShell({ dashboard }: { dashboard: DashboardSpec }) {
  const [pageId, setPageId] = useState(dashboard.pages[0]!.id);
  const [architectureOpen, setArchitectureOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [evidenceIds, setEvidenceIds] = useState<string[] | null>(null);
  const [telemetry, setTelemetry] = useState<SessionTelemetry>({
    evidenceOpens: 0,
    nextActionReviewed: false,
    evidenceTaskTarget: "",
    evidenceTaskStatus: "idle",
    evidenceTaskInteractions: 0,
    usefulness: "",
    issues: [],
    needCategory: "",
  });
  const page =
    dashboard.pages.find((candidate) => candidate.id === pageId) ??
    dashboard.pages[0]!;
  const selectedEvidence = useMemo(
    () => dashboard.evidence.filter((item) => evidenceIds?.includes(item.id)),
    [dashboard.evidence, evidenceIds],
  );
  const recordEvidenceTaskActivation = () => {
    setTelemetry((current) =>
      current.evidenceTaskStatus === "active"
        ? {
            ...current,
            evidenceTaskInteractions: current.evidenceTaskInteractions + 1,
          }
        : current,
    );
  };
  const openEvidence = (
    ids: string[],
    recordsNextAction = false,
    evidenceTaskTarget?: EvidenceTaskTarget,
  ) => {
    setEvidenceIds(ids);
    setTelemetry((current) => ({
      ...current,
      evidenceOpens: current.evidenceOpens + 1,
      nextActionReviewed: current.nextActionReviewed || recordsNextAction,
      evidenceTaskStatus:
        current.evidenceTaskStatus === "active" &&
        evidenceTaskTarget === current.evidenceTaskTarget
          ? "complete"
          : current.evidenceTaskStatus,
    }));
  };
  const closeFeedback = () => {
    setFeedbackOpen(false);
    setTelemetry((current) =>
      current.evidenceTaskStatus === "armed"
        ? { ...current, evidenceTaskStatus: "active" }
        : current,
    );
  };
  const modalOpen = architectureOpen || feedbackOpen || evidenceIds !== null;

  return (
    <div
      className="app-shell"
      onClickCapture={(event) =>
        event.detail === 0 && recordEvidenceTaskActivation()
      }
      onKeyDownCapture={(event) =>
        event.key === "Escape" && recordEvidenceTaskActivation()
      }
      onPointerDownCapture={recordEvidenceTaskActivation}
    >
      <div
        aria-hidden={modalOpen || undefined}
        className="app-content"
        inert={modalOpen || undefined}
      >
        <header className="topbar">
          <div className="brand">
            <span className="brand-mark">D</span>
            <span>Dasher</span>
          </div>
          <div className="top-actions">
            <span
              className={`freshness freshness-${dashboard.freshness.status}`}
            >
              {dashboard.freshness.label}
            </span>
            <button
              className="architecture-button"
              onClick={() => setArchitectureOpen(true)}
              type="button"
            >
              <span aria-hidden="true">⌘</span> Architecture
            </button>
          </div>
        </header>

        <div className="workspace">
          <aside className="sidebar">
            <div>
              <span className="eyebrow">
                {dashboard.dataMode === "live"
                  ? "Live dashboard"
                  : "Demo dashboard"}
              </span>
              <h1>{dashboard.title}</h1>
              <p>{dashboard.audience}</p>
            </div>
            <nav aria-label="Dashboard pages">
              {dashboard.pages.map((candidate, index) => (
                <button
                  aria-current={candidate.id === page.id ? "page" : undefined}
                  className={candidate.id === page.id ? "active" : ""}
                  key={candidate.id}
                  onClick={() => setPageId(candidate.id)}
                  type="button"
                >
                  <span>0{index + 1}</span>
                  {candidate.title}
                </button>
              ))}
            </nav>
            <div className="sidebar-next">
              <span>Next safe action</span>
              <strong>{dashboard.nextAction.title}</strong>
              <p>{dashboard.nextAction.detail}</p>
              <button
                className="next-evidence"
                onClick={() =>
                  openEvidence(
                    dashboard.nextAction.evidenceIds,
                    true,
                    "next-action",
                  )
                }
                type="button"
              >
                Why this action
              </button>
            </div>
          </aside>

          <main>
            <div className="page-heading">
              <div>
                <span className="eyebrow">{page.title}</span>
                <h2>{page.description}</h2>
              </div>
              <div className="updated">
                <span>Latest observation</span>
                <strong>
                  {dashboard.freshness.latestObservationAt
                    ? new Date(
                        dashboard.freshness.latestObservationAt,
                      ).toLocaleTimeString("en-US", {
                        hour: "numeric",
                        minute: "2-digit",
                        timeZone: "UTC",
                      })
                    : "Unknown"}{" "}
                  UTC
                </strong>
              </div>
            </div>
            <div className="mobile-status">
              <span
                className={`freshness freshness-${dashboard.freshness.status}`}
              >
                {dashboard.freshness.label}
              </span>
              <span>
                Latest observation:{" "}
                {dashboard.freshness.latestObservationAt
                  ? `${new Date(dashboard.freshness.latestObservationAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" })} UTC`
                  : "Unknown"}
              </span>
            </div>
            {page.id === "overview" && dashboard.schemaVersion === "1.2" ? (
              <ExecutiveBrief dashboard={dashboard} onEvidence={openEvidence} />
            ) : null}
            <div className="dashboard-grid">
              {page.components.map((component) => (
                <ComponentRenderer
                  component={component}
                  key={component.id}
                  onEvidence={openEvidence}
                />
              ))}
            </div>
            <button
              className="session-feedback-button"
              onClick={() => setFeedbackOpen(true)}
              type="button"
            >
              Session feedback · not saved
            </button>
            <footer>
              <span aria-hidden="true">ⓘ</span>
              {dashboard.notice}
            </footer>
          </main>
        </div>
      </div>

      {architectureOpen ? (
        <ArchitectureDialog
          architecture={dashboard.architecture}
          onClose={() => setArchitectureOpen(false)}
        />
      ) : null}
      {feedbackOpen ? (
        <SessionFeedbackDialog
          onClose={closeFeedback}
          onEvidenceTaskTarget={(value) =>
            setTelemetry((current) => ({
              ...current,
              evidenceTaskTarget: value,
              evidenceTaskStatus: "idle",
              evidenceTaskInteractions: 0,
            }))
          }
          onIssue={(value, checked) =>
            setTelemetry((current) => ({
              ...current,
              issues: checked
                ? [...new Set([...current.issues, value])]
                : current.issues.filter((issue) => issue !== value),
            }))
          }
          onNeedCategory={(value) =>
            setTelemetry((current) => ({ ...current, needCategory: value }))
          }
          onStartEvidenceTask={() =>
            setTelemetry((current) => ({
              ...current,
              evidenceTaskStatus: "armed",
              evidenceTaskInteractions: 0,
            }))
          }
          onUsefulness={(value) =>
            setTelemetry((current) => ({ ...current, usefulness: value }))
          }
          telemetry={telemetry}
        />
      ) : null}
      {evidenceIds ? (
        <EvidenceDrawer
          evidence={selectedEvidence}
          onClose={() => setEvidenceIds(null)}
        />
      ) : null}
    </div>
  );
}
