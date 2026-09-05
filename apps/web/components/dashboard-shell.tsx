"use client";

import {
  packComponents,
  type DashboardSpec,
  type Evidence,
} from "@dasher/dashboard-schema";
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

function ExecutiveBrief({
  dashboard,
  onEvidence,
}: {
  dashboard: Extract<DashboardSpec, { schemaVersion: "1.2" }>;
  onEvidence: (ids: string[]) => void;
}) {
  const supportingItems = [
    {
      label: "Known",
      ...dashboard.executiveBrief.known,
    },
    {
      label: "Changed",
      ...dashboard.executiveBrief.changed,
    },
  ];
  const important = dashboard.executiveBrief.important;

  const statementTypes = (values: string[]) =>
    values.map((value) => value[0]!.toUpperCase() + value.slice(1)).join(" · ");

  return (
    <section
      aria-labelledby="executive-brief-heading"
      className="executive-brief"
    >
      <div className="executive-brief-heading">
        <span className="eyebrow">Decision view</span>
        <h2 id="executive-brief-heading">Executive brief</h2>
      </div>
      <div className="executive-brief-composition">
        <article aria-label="Primary finding" className="executive-primary">
          <div className="executive-brief-meta">
            <span className="executive-brief-label">Important</span>
            <span className="executive-statement-types">
              {statementTypes(important.statementTypes)}
            </span>
          </div>
          <h3>{important.headline}</h3>
          <p>{important.detail}</p>
          <button
            aria-label="Evidence for Important"
            className="executive-brief-evidence"
            onClick={() => onEvidence(important.evidenceIds)}
            type="button"
          >
            View evidence
          </button>
        </article>

        <div
          aria-label="Supporting context"
          className="executive-support"
          role="group"
        >
          <ol className="executive-support-list">
            {supportingItems.map((item) => (
              <li className="executive-support-item" key={item.label}>
                <div className="executive-brief-meta">
                  <span className="executive-brief-label">{item.label}</span>
                  <span className="executive-statement-types">
                    {statementTypes(item.statementTypes)}
                  </span>
                </div>
                <h3>{item.headline}</h3>
                <p>{item.detail}</p>
                <button
                  aria-label={`Evidence for ${item.label}`}
                  className="executive-brief-evidence"
                  onClick={() => onEvidence(item.evidenceIds)}
                  type="button"
                >
                  View evidence
                </button>
              </li>
            ))}
          </ol>
        </div>

        <article aria-label="Next safe action" className="executive-action">
          <div className="executive-brief-meta">
            <span className="executive-brief-label">Next safe action</span>
            <span className="executive-statement-types">Recommended</span>
          </div>
          <h3>{dashboard.nextAction.title}</h3>
          <p>{dashboard.nextAction.detail}</p>
          <button
            aria-label="Evidence for Next safe action"
            className="executive-brief-evidence executive-action-evidence"
            onClick={() => onEvidence(dashboard.nextAction.evidenceIds)}
            type="button"
          >
            Why this action <span aria-hidden="true">→</span>
          </button>
        </article>
      </div>
    </section>
  );
}

export function DashboardShell({
  dashboard,
  sealed = false,
}: {
  dashboard: DashboardSpec;
  /**
   * True when these bytes came back from storage rather than from a build that
   * just ran.
   *
   * DELIBERATELY A RENDER PROP AND NOT A FIELD ON THE SPEC. A saved dashboard's
   * bytes are byte-identical to the ones that were sealed — that is the whole
   * persistence promise, and `canonicalSpecBytes` hashes them. Recording
   * "reopened" inside the spec would either mutate what was sealed or make the
   * stored bytes disagree with the rendered page. Whether a reader is looking
   * at a fresh build or a stored one is a fact about this render, so it lives
   * here.
   */
  sealed?: boolean;
}) {
  const [pageId, setPageId] = useState(dashboard.pages[0]!.id);
  const [architectureOpen, setArchitectureOpen] = useState(false);
  const [evidenceIds, setEvidenceIds] = useState<string[] | null>(null);
  const page =
    dashboard.pages.find((candidate) => candidate.id === pageId) ??
    dashboard.pages[0]!;
  const decisionRegionPresent =
    page.id === dashboard.pages[0]!.id && dashboard.schemaVersion === "1.2";
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
              {/*
                Three states, because there are three things worth telling a
                reader apart: data arriving live, data captured for a
                demonstration, and a page that is neither because it is a
                record of a build that already happened. `sealed` wins — a
                stored dashboard is a snapshot however its data was originally
                fetched, and "Live dashboard" on bytes frozen last Tuesday is
                the least true thing this badge could say.
              */}
              <span className="eyebrow">
                {sealed
                  ? "Saved snapshot"
                  : dashboard.dataMode === "live"
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
            {decisionRegionPresent ? null : (
              <div className="sidebar-next">
                <span>Next safe action</span>
                <strong>{dashboard.nextAction.title}</strong>
                <p>{dashboard.nextAction.detail}</p>
                <button
                  className="next-evidence"
                  onClick={() =>
                    setEvidenceIds(dashboard.nextAction.evidenceIds)
                  }
                  type="button"
                >
                  Why this action
                </button>
              </div>
            )}
          </aside>

          <main>
            <div className="page-heading">
              <div>
                <span className="eyebrow">{page.title}</span>
                <h2>{page.description}</h2>
              </div>
              {/*
                Omitted entirely when there is no instant, rather than filled
                in with a word. A source with no moment of observation — a
                monthly ledger, say — names its period in the freshness label
                instead, and "Unknown UTC" would be a unit on a non-value.
              */}
              {dashboard.freshness.latestObservationAt === undefined ? null : (
                <div className="updated">
                  <span>Latest observation</span>
                  <strong>
                    {new Date(
                      dashboard.freshness.latestObservationAt,
                    ).toLocaleTimeString("en-US", {
                      hour: "numeric",
                      minute: "2-digit",
                      timeZone: "UTC",
                    })}{" "}
                    UTC
                  </strong>
                </div>
              )}
            </div>
            <div className="mobile-status">
              <span
                className={`freshness freshness-${dashboard.freshness.status}`}
              >
                {dashboard.freshness.label}
              </span>
              {dashboard.freshness.latestObservationAt === undefined ? null : (
                <span>
                  Latest observation:{" "}
                  {`${new Date(dashboard.freshness.latestObservationAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" })} UTC`}
                </span>
              )}
            </div>
            {/*
              One brief per dashboard, on the page the reader lands on. The
              gate is "first page", not a page id: a builder may name its
              landing page anything, and the brief must not depend on it.
            */}
            {decisionRegionPresent ? (
              <ExecutiveBrief
                dashboard={dashboard}
                onEvidence={setEvidenceIds}
              />
            ) : null}
            <div className="dashboard-grid">
              {/*
                Widths come from the packer, not from each component deciding
                for itself. Order is untouched — the packer only says how wide.
              */}
              {packComponents(page.components).map(({ component, span }) => (
                <ComponentRenderer
                  component={component}
                  key={component.id}
                  onEvidence={setEvidenceIds}
                  span={span}
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
