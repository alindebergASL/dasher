"use client";

import { useState, useTransition } from "react";

import { uploadLedgerDashboard } from "@/app/actions";
import { REQUEST_MAX_LENGTH, type PlanResult } from "@/app/planning";

/**
 * Build a dashboard from a ledger export the reader has on their own machine.
 *
 * WHY IT IS FOLDED AWAY. The request bar above it answers "what do you want to
 * monitor" in one line, and this cannot: a file has to be chosen and four
 * things declared about it. Put inline, that is six controls in front of every
 * reader for a path most of them will not take. Closed by default, it is a
 * disclosure somebody opens when they have a file.
 *
 * WHY IT ASKS FOR SO MUCH. A CSV carries cells and nothing else. It does not
 * say what it is called, what currency its figures are in, what one column
 * means, or when it was exported — and all four appear on the dashboard. The
 * alternative to asking is guessing from the filename or the clock, which would
 * put an invention into the part of the product that is supposed to be
 * checkable. Each field says why it is there, so the form reads as the price of
 * a dashboard that can be trusted rather than as bureaucracy.
 *
 * WHY IT IS A NATIVE FORM POST INTO A SERVER ACTION. The file never becomes a
 * string in this component and is never held in state: the browser streams the
 * `FormData` and the action reads bytes. Anything else would mean the file
 * existing twice, once in a shape nothing needs.
 */
export function LedgerUpload({
  disabled,
  onBuilt,
}: {
  disabled: boolean;
  onBuilt: (result: PlanResult, request: string) => void;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | undefined>(undefined);

  return (
    <details className="upload-bar">
      <summary className="upload-summary">
        Build one from your own ledger export
      </summary>

      <form
        className="upload-form"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const request = String(data.get("request") ?? "");
          startTransition(async () => {
            const result = await uploadLedgerDashboard(data);
            setError(result.ok ? undefined : result.error);
            // Handed upward ONLY on success. A refusal belongs beside the
            // field the reader has to change — "that file is not UTF-8" at the
            // top of the page, above a form that is still open below it, would
            // be the same sentence in the wrong place, twice.
            if (result.ok) onBuilt(result, request);
          });
        }}
      >
        <p className="upload-note">
          A CSV with a <code>line_id</code>, <code>label</code> and{" "}
          <code>budget_per_period</code> column, plus one column per period
          named like <code>2026-03</code>. The file is stored as the evidence
          behind the dashboard it builds.
        </p>

        <label className="request-label" htmlFor="upload-file">
          Ledger export (CSV)
        </label>
        <input
          accept=".csv,text/csv"
          className="upload-file"
          id="upload-file"
          name="file"
          required
          type="file"
        />

        <label className="request-label" htmlFor="upload-request">
          What should the dashboard show?
        </label>
        <input
          autoComplete="off"
          className="request-input"
          defaultValue="Operating spend by category"
          id="upload-request"
          maxLength={REQUEST_MAX_LENGTH}
          name="request"
          type="text"
        />

        <div className="upload-grid">
          <div className="upload-field">
            <label className="request-label" htmlFor="upload-source-name">
              What is this export called?
            </label>
            <input
              autoComplete="off"
              className="request-input"
              defaultValue="Operating ledger export"
              id="upload-source-name"
              maxLength={120}
              name="sourceName"
              type="text"
            />
          </div>

          <div className="upload-field">
            <label className="request-label" htmlFor="upload-currency">
              Currency
            </label>
            <input
              autoComplete="off"
              className="request-input"
              defaultValue="USD"
              id="upload-currency"
              maxLength={3}
              name="currency"
              placeholder="USD"
              type="text"
            />
          </div>

          <div className="upload-field">
            <label className="request-label" htmlFor="upload-period-label">
              One column is a…
            </label>
            <input
              autoComplete="off"
              className="request-input"
              defaultValue="month"
              id="upload-period-label"
              maxLength={32}
              name="periodLabel"
              placeholder="month"
              type="text"
            />
          </div>

          <div className="upload-field">
            <label className="request-label" htmlFor="upload-exported-on">
              Exported on
            </label>
            <input
              className="request-input"
              id="upload-exported-on"
              name="exportedOn"
              type="date"
            />
          </div>
        </div>

        <p className="upload-note">
          The export date is what the dashboard shows as how current its figures
          are. It is asked for rather than taken from the clock, because a file
          exported last quarter is not accurate to this second.
        </p>

        <div className="request-row">
          <button
            className="request-submit"
            disabled={disabled || pending}
            type="submit"
          >
            {pending ? "Reading…" : "Build from this file"}
          </button>
        </div>

        {error !== undefined ? (
          <p className="request-error" role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </details>
  );
}
