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

export function DashboardShell({ dashboard }: { dashboard: DashboardSpec }) {
  const [pageId, setPageId] = useState(dashboard.pages[0]!.id);
  const [architectureOpen, setArchitectureOpen] = useState(false);
  const [evidenceIds, setEvidenceIds] = useState<string[] | null>(null);
  const page =
    dashboard.pages.find((candidate) => candidate.id === pageId) ??
    dashboard.pages[0]!;
  const selectedEvidence = useMemo(
    () => dashboard.evidence.filter((item) => evidenceIds?.includes(item.id)),
    [dashboard.evidence, evidenceIds],
  );
  const modalOpen = architectureOpen || evidenceIds !== null;

  return (
    <div className="app-shell">
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
                onClick={() => setEvidenceIds(dashboard.nextAction.evidenceIds)}
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
            <div className="mobile-next">
              <span>Next safe action</span>
              <strong>{dashboard.nextAction.title}</strong>
              <p>{dashboard.nextAction.detail}</p>
              <button
                className="next-evidence"
                onClick={() => setEvidenceIds(dashboard.nextAction.evidenceIds)}
                type="button"
              >
                Why this action
              </button>
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
            <div className="dashboard-grid">
              {page.components.map((component) => (
                <ComponentRenderer
                  component={component}
                  key={component.id}
                  onEvidence={setEvidenceIds}
                />
              ))}
            </div>
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
      {evidenceIds ? (
        <EvidenceDrawer
          evidence={selectedEvidence}
          onClose={() => setEvidenceIds(null)}
        />
      ) : null}
    </div>
  );
}
