"use client";

import type { DashboardComponent } from "@dasher/dashboard-schema";

interface ComponentPartProps {
  component: DashboardComponent;
  onEvidence: (ids: string[]) => void;
}

interface ComponentRendererProps extends ComponentPartProps {
  /** Columns out of `LAYOUT_COLUMNS`, decided by the packer. */
  span: number;
}

function SourcesButton({
  ids,
  onEvidence,
}: {
  ids: string[];
  onEvidence: (ids: string[]) => void;
}) {
  if (ids.length === 0) return null;
  return (
    <button
      className="sources-button"
      type="button"
      onClick={() => onEvidence(ids)}
    >
      View {ids.length} evidence {ids.length === 1 ? "item" : "items"}
    </button>
  );
}

function ItemEvidenceButton({
  ids,
  label,
  onEvidence,
}: {
  ids: string[];
  label: string;
  onEvidence: (ids: string[]) => void;
}) {
  return (
    <button
      aria-label={`Evidence for ${label}`}
      className="item-evidence"
      onClick={() => onEvidence(ids)}
      type="button"
    >
      Evidence
    </button>
  );
}

function ComponentHeader({ component, onEvidence }: ComponentPartProps) {
  return (
    <div className="component-heading">
      <div>
        <h2>{component.title}</h2>
        {component.subtitle ? <p>{component.subtitle}</p> : null}
      </div>
      <SourcesButton ids={component.evidenceIds} onEvidence={onEvidence} />
    </div>
  );
}

/**
 * The series' latest value, formatted the way every other figure on the page
 * is. `toLocaleString()` printed "1,250 USD" beside a card reading "$1,250.00".
 * A three-letter unit is a currency; anything else is a bare quantity.
 */
function latestPoint(
  series: Extract<DashboardComponent, { kind: "trend-list" }>["series"][number],
): string {
  const value = series.points.at(-1)?.value;
  if (value === undefined) return "";
  const currency = /^[A-Z]{3}$/u.test(series.unit) ? series.unit : undefined;
  const formatted = new Intl.NumberFormat("en-US", {
    ...(currency === undefined ? {} : { style: "currency", currency }),
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(value);
  return currency === undefined ? `${formatted} ${series.unit}` : formatted;
}

function MiniTrend({
  points,
}: {
  points: Array<{ at: string; value: number }>;
}) {
  const width = 280;
  const height = 72;
  const values = points.map((point) => point.value);
  const times = points.map((point) => Date.parse(point.at));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const minTime = Math.min(...times);
  const timeRange = Math.max(...times) - minTime || 1;
  const coordinates = points
    .map((point) => {
      const x = ((Date.parse(point.at) - minTime) / timeRange) * width;
      const y = height - ((point.value - min) / range) * (height - 12) - 6;
      return `${x},${y}`;
    })
    .join(" ");
  return (
    <svg
      className="mini-trend"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="Recent trend line"
    >
      <polyline
        points={coordinates}
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ComponentRenderer({
  component,
  onEvidence,
  span,
}: ComponentRendererProps) {
  switch (component.kind) {
    case "summary":
      return (
        <section
          className={`panel summary-panel tone-${component.tone}`}
          data-span={span}
        >
          <ComponentHeader component={component} onEvidence={onEvidence} />
          <div className="summary-copy">
            {component.claims.map((claim, index) => (
              <p key={`${component.id}:claim:${index}`}>
                {claim.text}{" "}
                <button
                  aria-label={`Evidence for: ${claim.text}`}
                  className="claim-evidence"
                  onClick={() => onEvidence(claim.evidenceIds)}
                  type="button"
                >
                  Evidence
                </button>
              </p>
            ))}
          </div>
        </section>
      );
    case "metric-grid":
      return (
        <section className="panel" data-span={span}>
          <ComponentHeader component={component} onEvidence={onEvidence} />
          <div className="metric-grid">
            {component.metrics.map((metric, index) => (
              <div
                className="metric-card"
                key={`${component.id}:metric:${index}`}
              >
                <span>{metric.label}</span>
                <strong>{metric.value}</strong>
                {metric.change ? <small>{metric.change}</small> : null}
                <ItemEvidenceButton
                  ids={metric.evidenceIds}
                  label={metric.label}
                  onEvidence={onEvidence}
                />
              </div>
            ))}
          </div>
        </section>
      );
    case "table":
      return (
        <section className="panel" data-span={span}>
          <ComponentHeader component={component} onEvidence={onEvidence} />
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  {component.columns.map((column, index) => (
                    <th key={`${component.id}:column:${index}`} scope="col">
                      {column}
                    </th>
                  ))}
                  <th className="table-evidence" scope="col">
                    <span className="sr-only">Evidence</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {component.rows.map((row) => (
                  <tr key={row.id}>
                    {row.cells.map((cell, index) => (
                      <td key={`${row.id}:${index}`}>{cell}</td>
                    ))}
                    <td className="table-evidence">
                      <ItemEvidenceButton
                        ids={row.evidenceIds}
                        label={`${row.cells[0] || row.id} row`}
                        onEvidence={onEvidence}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      );
    case "ranking":
      return (
        <section className="panel" data-span={span}>
          <ComponentHeader component={component} onEvidence={onEvidence} />
          <ol className="ranking-list">
            {component.items.map((item, index) => (
              <li key={item.id}>
                <span className="rank-number">{index + 1}</span>
                <div>
                  <strong>{item.label}</strong>
                  {item.note ? <small>{item.note}</small> : null}
                </div>
                <b>{item.value}</b>
                <ItemEvidenceButton
                  ids={item.evidenceIds}
                  label={`${item.label} ranking`}
                  onEvidence={onEvidence}
                />
              </li>
            ))}
          </ol>
        </section>
      );
    case "alert-list":
      return (
        <section className="panel" data-span={span}>
          <ComponentHeader component={component} onEvidence={onEvidence} />
          <div className="alert-list">
            {component.alerts.map((alert) => (
              <article
                className={`alert alert-${alert.severity}`}
                key={alert.id}
              >
                <span className="alert-icon" aria-hidden="true">
                  {alert.severity === "warning" ? "!" : "i"}
                </span>
                <div>
                  <strong>{alert.title}</strong>
                  <p>{alert.detail}</p>
                  <ItemEvidenceButton
                    ids={alert.evidenceIds}
                    label={`${alert.title} alert`}
                    onEvidence={onEvidence}
                  />
                </div>
              </article>
            ))}
          </div>
        </section>
      );
    case "trend-list":
      return (
        <section className="panel" data-span={span}>
          <ComponentHeader component={component} onEvidence={onEvidence} />
          <div className="trend-grid">
            {component.series.map((series) => (
              <article className="trend-card" key={series.id}>
                <div>
                  <strong>{series.label}</strong>
                  <span>{latestPoint(series)}</span>
                  <ItemEvidenceButton
                    ids={series.evidenceIds}
                    label={`${series.label} trend`}
                    onEvidence={onEvidence}
                  />
                </div>
                <MiniTrend points={series.points} />
              </article>
            ))}
          </div>
        </section>
      );
    default: {
      const exhaustive: never = component;
      throw new Error(
        `Unsupported dashboard component: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}
