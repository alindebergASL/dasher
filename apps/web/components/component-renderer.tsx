"use client";

import type { DashboardComponent } from "@dasher/dashboard-schema";
import { useState } from "react";

interface ComponentRendererProps {
  component: DashboardComponent;
  onEvidence: (ids: string[]) => void;
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
      View {ids.length} source{ids.length === 1 ? "" : "s"}
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

function ComponentHeader({ component, onEvidence }: ComponentRendererProps) {
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

function GaugeMap({
  gauges,
  onEvidence,
}: {
  gauges: Extract<DashboardComponent, { kind: "gauge-map" }>["gauges"];
  onEvidence: (ids: string[]) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = gauges.find((gauge) => gauge.id === selectedId) ?? null;
  const latitudes = gauges.map((gauge) => gauge.latitude);
  const longitudes = gauges.map((gauge) => gauge.longitude);
  const minLat = Math.min(...latitudes);
  const maxLat = Math.max(...latitudes);
  const minLon = Math.min(...longitudes);
  const maxLon = Math.max(...longitudes);
  return (
    <div className="map-panel" aria-label="Gauge locations near Sacramento">
      <div className="map-river river-one" />
      <div className="map-river river-two" />
      <span className="map-city">Sacramento</span>
      {gauges.map((gauge) => {
        const left =
          12 + ((gauge.longitude - minLon) / (maxLon - minLon || 1)) * 76;
        const top =
          12 + (1 - (gauge.latitude - minLat) / (maxLat - minLat || 1)) * 70;
        return (
          <button
            aria-label={`${gauge.name}, station ${gauge.id}: ${gauge.stage ?? "missing"} ${gauge.stageUnit}, ${gauge.direction}`}
            aria-pressed={selectedId === gauge.id}
            className={`map-marker marker-${gauge.direction}${selectedId === gauge.id ? " selected" : ""}`}
            key={gauge.id}
            onClick={() => setSelectedId(gauge.id)}
            style={{ left: `${left}%`, top: `${top}%` }}
            title={`${gauge.name}: ${gauge.stage ?? "missing"} ${gauge.stageUnit}, ${gauge.direction}`}
            type="button"
          >
            <span className="sr-only">{gauge.name}</span>
          </button>
        );
      })}
      <div className="map-legend">
        <span>
          <i className="legend-dot rising" /> Rising
        </span>
        <span>
          <i className="legend-dot falling" /> Falling
        </span>
        <span>
          <i className="legend-dot steady" /> Steady
        </span>
      </div>
      {selected ? (
        <aside aria-live="polite" className="map-selection">
          <strong>{selected.name}</strong>
          <span>Station {selected.id}</span>
          <span>
            {selected.stage === null
              ? "Water level missing"
              : `${selected.stage.toLocaleString()} ${selected.stageUnit}`}{" "}
            · {selected.direction}
          </span>
          <span>
            {selected.latitude.toFixed(4)}, {selected.longitude.toFixed(4)}
          </span>
          <ItemEvidenceButton
            ids={selected.evidenceIds}
            label={`${selected.name} map reading`}
            onEvidence={onEvidence}
          />
        </aside>
      ) : null}
    </div>
  );
}

export function ComponentRenderer({
  component,
  onEvidence,
}: ComponentRendererProps) {
  switch (component.kind) {
    case "summary":
      return (
        <section className={`panel summary-panel tone-${component.tone}`}>
          <ComponentHeader component={component} onEvidence={onEvidence} />
          <div className="summary-copy">
            {component.claims.map((claim) => (
              <p key={claim.text}>
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
        <section className="panel span-full">
          <ComponentHeader component={component} onEvidence={onEvidence} />
          <div className="metric-grid">
            {component.metrics.map((metric) => (
              <div className="metric-card" key={metric.label}>
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
    case "gauge-map":
      return (
        <section className="panel map-card span-two">
          <ComponentHeader component={component} onEvidence={onEvidence} />
          <GaugeMap gauges={component.gauges} onEvidence={onEvidence} />
        </section>
      );
    case "ranking":
      return (
        <section className="panel">
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
        <section className="panel">
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
    case "gauge-table":
      return (
        <section className="panel span-full">
          <ComponentHeader component={component} onEvidence={onEvidence} />
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Gauge</th>
                  <th>Water level</th>
                  <th>Streamflow</th>
                  <th>Direction</th>
                  <th>Data</th>
                </tr>
              </thead>
              <tbody>
                {component.gauges.map((gauge) => (
                  <tr key={gauge.id}>
                    <td>
                      <strong>{gauge.river}</strong>
                      <small>{gauge.id}</small>
                      <ItemEvidenceButton
                        ids={gauge.evidenceIds}
                        label={`${gauge.name} row`}
                        onEvidence={onEvidence}
                      />
                    </td>
                    <td>
                      {gauge.stage === null
                        ? "Missing"
                        : `${gauge.stage.toLocaleString()} ${gauge.stageUnit}`}
                    </td>
                    <td>
                      {gauge.streamflow === null
                        ? "Missing"
                        : `${gauge.streamflow.toLocaleString()} ${gauge.streamflowUnit}`}
                    </td>
                    <td>
                      <span className={`status status-${gauge.direction}`}>
                        {gauge.direction}
                      </span>
                    </td>
                    <td>
                      <span
                        className={`freshness freshness-${gauge.freshness}`}
                      >
                        {gauge.freshness}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      );
    case "trend-list":
      return (
        <section className="panel span-full">
          <ComponentHeader component={component} onEvidence={onEvidence} />
          <div className="trend-grid">
            {component.series.map((series) => (
              <article className="trend-card" key={series.id}>
                <div>
                  <strong>{series.label}</strong>
                  <span>
                    {series.points.at(-1)?.value.toLocaleString()} {series.unit}
                  </span>
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
