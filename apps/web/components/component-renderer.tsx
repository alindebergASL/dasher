"use client";

import type { DashboardComponent } from "@dasher/dashboard-schema";
import { useState } from "react";

interface ComponentPartProps {
  component: DashboardComponent;
  onEvidence: (ids: string[]) => void;
}

interface ComponentRendererProps extends ComponentPartProps {
  /**
   * Columns out of `LAYOUT_COLUMNS`, decided by the packer. The width used to
   * be hardcoded here, one kind at a time, which is how five of seven ended up
   * claiming the full row and the sixth was left stranded in a third of one.
   */
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

function StationMap({
  label,
  stations,
  onEvidence,
}: {
  label: string;
  stations: Extract<DashboardComponent, { kind: "station-map" }>["stations"];
  onEvidence: (ids: string[]) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected =
    stations.find((station) => station.id === selectedId) ?? null;
  const latitudes = stations.map((station) => station.latitude);
  const longitudes = stations.map((station) => station.longitude);
  const minLat = Math.min(...latitudes);
  const maxLat = Math.max(...latitudes);
  const minLon = Math.min(...longitudes);
  const maxLon = Math.max(...longitudes);
  return (
    <div className="map-panel" aria-label={label}>
      <div className="map-river river-one" />
      <div className="map-river river-two" />
      <span className="map-city">Sacramento</span>
      {stations.map((station) => {
        const left =
          12 + ((station.longitude - minLon) / (maxLon - minLon || 1)) * 76;
        const top =
          12 + (1 - (station.latitude - minLat) / (maxLat - minLat || 1)) * 70;
        const reading = `${station.primary.value ?? "missing"} ${station.primary.unit}`;
        return (
          <button
            aria-label={`${station.name}, station ${station.id}: ${reading}, ${station.direction}`}
            aria-pressed={selectedId === station.id}
            className={`map-marker marker-${station.direction}${selectedId === station.id ? " selected" : ""}`}
            key={station.id}
            onClick={() => setSelectedId(station.id)}
            style={{ left: `${left}%`, top: `${top}%` }}
            title={`${station.name}: ${reading}, ${station.direction}`}
            type="button"
          >
            <span className="sr-only">{station.name}</span>
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
            {selected.primary.value === null
              ? "Reading missing"
              : `${selected.primary.value.toLocaleString()} ${selected.primary.unit}`}{" "}
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
    case "station-map":
      return (
        <section className="panel" data-span={span}>
          <ComponentHeader component={component} onEvidence={onEvidence} />
          <StationMap
            label={component.title}
            onEvidence={onEvidence}
            stations={component.stations}
          />
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
    case "station-table":
      return (
        <section className="panel" data-span={span}>
          <ComponentHeader component={component} onEvidence={onEvidence} />
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{component.columns.station}</th>
                  <th>{component.columns.primary}</th>
                  <th>{component.columns.secondary}</th>
                  <th>Direction</th>
                  <th>Data</th>
                </tr>
              </thead>
              <tbody>
                {component.stations.map((station) => (
                  <tr key={station.id}>
                    <td>
                      <strong>{station.group}</strong>
                      <small>{station.id}</small>
                      <ItemEvidenceButton
                        ids={station.evidenceIds}
                        label={`${station.name} row`}
                        onEvidence={onEvidence}
                      />
                    </td>
                    <td>
                      {station.primary.value === null
                        ? "Missing"
                        : `${station.primary.value.toLocaleString()} ${station.primary.unit}`}
                    </td>
                    <td>
                      {station.secondary.value === null
                        ? "Missing"
                        : `${station.secondary.value.toLocaleString()} ${station.secondary.unit}`}
                    </td>
                    <td>
                      <span className={`status status-${station.direction}`}>
                        {station.direction}
                      </span>
                    </td>
                    <td>
                      <span
                        className={`freshness freshness-${station.freshness}`}
                      >
                        {station.freshness}
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
        <section className="panel" data-span={span}>
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
