"use client";

import type { DashboardSpec } from "@dasher/dashboard-schema";

import { useModalFocus } from "./use-modal-focus";

interface ArchitectureDialogProps {
  architecture: DashboardSpec["architecture"];
  onClose: () => void;
}

export function ArchitectureDialog({
  architecture,
  onClose,
}: ArchitectureDialogProps) {
  const { closeButtonRef, containerRef } = useModalFocus<HTMLElement>(onClose);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        aria-labelledby="architecture-title"
        aria-modal="true"
        className="modal architecture-modal"
        ref={containerRef}
        role="dialog"
      >
        <div className="modal-heading">
          <div>
            <span className="eyebrow">Behind this dashboard</span>
            <h2 id="architecture-title">{architecture.title}</h2>
          </div>
          <button
            aria-label="Close architecture"
            className="icon-button"
            onClick={onClose}
            ref={closeButtonRef}
            type="button"
          >
            ×
          </button>
        </div>
        <p className="architecture-summary">{architecture.summary}</p>
        <div className="architecture-connections">
          {architecture.edges.map((edge) => {
            const from = architecture.nodes.find(
              (node) => node.id === edge.from,
            )!;
            const to = architecture.nodes.find((node) => node.id === edge.to)!;
            return (
              <div
                className="architecture-connection"
                key={JSON.stringify([edge.from, edge.to, edge.label])}
              >
                <article className={`architecture-step node-${from.kind}`}>
                  <strong>{from.label}</strong>
                  <p>{from.detail}</p>
                </article>
                <div className="connection-arrow">
                  <span>{edge.label}</span>
                  <b aria-hidden="true">→</b>
                </div>
                <article className={`architecture-step node-${to.kind}`}>
                  <strong>{to.label}</strong>
                  <p>{to.detail}</p>
                </article>
              </div>
            );
          })}
        </div>
        <p className="plain-note">
          This diagram is generated from the same source and calculation
          metadata as the dashboard, so it stays connected to what you see.
        </p>
      </section>
    </div>
  );
}
