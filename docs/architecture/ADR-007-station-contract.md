# ADR-007: The dashboard contract describes stations, not rivers

Status: Accepted
Date: 2026-08-18
Prior evidence: `docs/process/2026-08-18-is-the-compiler-river-shaped.md`

## Decision

The dashboard spec's `schemaVersion` moves to `1.2`. The two components that
carried river field names become generic:

| 1.1                             | 1.2                            |
| ------------------------------- | ------------------------------ |
| `gauge-map`, `gauge-table`      | `station-map`, `station-table` |
| `gauges: GaugeSchema[]`         | `stations: StationSchema[]`    |
| `river`                         | `group`                        |
| `stage` + `stageUnit`           | `primary: { value, unit }`     |
| `streamflow` + `streamflowUnit` | `secondary: { value, unit }`   |

Versions `1.0` and `1.1` are removed from the accepted union, not kept beside
`1.2`. This is the dashboard _contract_ (the Zod spec in
`@dasher/dashboard-schema`), not the database schema; ADR-006's migration
tiers are unaffected.

## Why the contract goes generic at all

The spike recorded in the process note compiled an air-quality dashboard
through the unmodified compiler; the shape already generalises. The only part
of the _sealed_ contract that does not is field naming in two components. A
contract whose field names belong to one domain makes every future domain a
schema change — which inverts the design. The contract's job is to cap shape:
a station has a location, a primary reading with a unit, a direction, a
freshness state. The domain's job is to supply words. `summary`,
`metric-grid`, `ranking`, `trend-list`, and `alert-list` already work this
way; `1.2` makes the last two components consistent with the other five.

`ranking`'s items and `trend-list`'s series already carry per-item `unit` and
free `label` fields, which is why they never needed this decision.

## Why old versions are dropped rather than kept

Persisted dashboards are sealed canonical bytes, and `/d/[id]` parses them at
render time with a documented failure mode: bytes the current contract
rejects are a 404, indistinguishable from not-found by design. At this
moment the count of dashboards persisted outside tests is zero. Carrying a
`1.1` branch in the renderer and validator forever, to protect rows that do
not exist, is the expensive option; the cheap one is only cheap today. That
is the entire reason this decision is being made now rather than when a
second domain ships.

If real dashboards exist at the _next_ contract change, this option is gone:
that change pays for either a migration or a multi-version renderer. This ADR
sets that expectation explicitly.

## What deliberately does not change

- **The plan contract.** `PLAN_SECTION_KINDS` still says `gauge-map` and
  `gauge-table`. The plan vocabulary is what providers were prompted with,
  what the committed eval corpus contains, and what the free-text gate was
  measured against; renaming it invalidates recorded evidence for zero
  structural gain. The compiler maps plan section `gauge-map` to component
  `station-map`. When a second _planning_ domain exists, the plan vocabulary
  becomes that change's problem, with its own eval run.
- **River prose.** "3 gauges monitored", threshold sentences, evidence
  labels — all computed text keeps its wording for the river domain. The
  contract change is structural; wording belongs to the layer that computes
  it and is threaded per-domain there.
- **Evidence ids.** `usgs-<siteId>` stays; the prefix belongs to the source,
  not the contract.
