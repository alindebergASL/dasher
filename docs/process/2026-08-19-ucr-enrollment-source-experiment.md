# UCR enrollment known-source experiment

Date: 2026-08-19

## Learning question

Can Dasher parse one official UC Riverside enrollment source and build an evidence-backed non-sensor dashboard without forcing enrollment into the station abstraction or inventing dates and definitions?

**Answer: yes for the current official snapshot, with two contract costs recorded below.** The existing summary, metric-grid, ranking, evidence, executive-brief, and architecture shapes are sufficient. No station, sensor, map, direction tolerance, or source credential is involved.

## Source decision

The primary source is UC Riverside Institutional Research's public Campus Facts Tables page. It reports Fall 2025 total enrollment of 27,633 students, including 24,034 undergraduate and 3,599 graduate students, and defines the count as distinct students enrolled in credit-bearing classes at the fall third-week census.[1]

UCR's 2025–26 Common Data Set independently reports the same undergraduate, graduate, and grand totals as of the institution's official Fall 2025 reporting date or October 15, 2025.[2] This corroboration is not merged into the dashboard: every displayed value comes from the Campus Facts page alone.

SmartQuery was considered but not selected. It is an official UCR Institutional Research tool for custom enrollment questions, but its dynamic query path is unnecessary for the bounded question answered here.[3]

Captured source:

- `fixtures/ucr/campus-facts-2025.html`
- Source URL: `https://ir.ucr.edu/campus-facts-tables`
- Retrieved: `2026-08-19T01:05:59.000Z`
- SHA-256: `06556cdc55ff559b47a6f85cf3a5917b38a9b1032526d3bb36ba3d4421d1603c`

## Parser proof

`parseUcrCampusFactsHtml` is source-specific and fail-closed. It requires:

- The named enrollment section and a supported `Enrollment - Fall YYYY` heading
- A strictly increasing year header
- Exactly the undergraduate, graduate, and total rows
- Equal row widths and integer counts
- `undergraduate + graduate = total` for every year
- Agreement between the latest table values and the overview prose
- The exact third-week census definition
- The approved official source URL and a valid retrieval timestamp

It does not claim arbitrary HTML support. If UCR changes the source structure or definition, parsing stops instead of silently carrying old assumptions forward.

## Dashboard proof

`buildUcrEnrollmentDashboard` produces a schema-1.2 dashboard with:

- Fall 2025 total, undergraduate, and graduate enrollment
- Undergraduate and graduate shares calculated from the source totals
- A comparable Fall 2024 to Fall 2025 total change
- The census definition in the executive brief, notice, and source evidence
- A direct link to the official source
- No station, sensor, gauge, monitor, geographic, or tolerance semantics
- No invented census timestamp

The artifact is deliberately `dataMode: "demo"`: it is built from a captured official source for an experiment, not fetched by the running product.

## What generalized

The shared contract's summary, metric-grid, ranking, evidence, and architecture components are not sensor-specific. A useful current enrollment dashboard can be built directly from a typed `EnrollmentSnapshot`; no generic `entity-domain` framework is needed.

## What did not generalize cleanly

1. **Top-level freshness vocabulary.** The contract requires `fresh | stale | partial`. An annual official census snapshot is neither a live fresh reading nor missing sensor data. The experiment uses `partial` with the explicit label `Official Fall 2025 third-week census snapshot; not real-time`. A future non-sensor product path should decide whether the contract needs a broader currency/reporting-period concept.
2. **Historical labels.** `trend-list` requires ISO timestamps, while the primary source provides fall-year labels rather than exact observation instants. The experiment does not convert `Fall 2025` into an invented date. It shows the current snapshot and one comparable year-over-year calculation, and records a general year/period table as a possible future contract addition.

Neither issue blocks the bounded current-enrollment dashboard. Both would matter before claiming a general institutional-data product.

## Deliberately absent

- No request router or web-product integration
- No live UCR fetch
- No autonomous source discovery
- No source recommendation UI
- No generic scraper or entity framework
- No demographic breakdowns
- No combination of UCR and IPEDS/CDS values
- No fabricated historical timestamps

## Next decision

If this experiment is accepted, the next product slice can ask whether a user understands a source recommendation before Dasher builds the dashboard through the real request and persistence path. That slice should address the currency/reporting-period vocabulary explicitly rather than smuggling institutional snapshots through sensor freshness language.

## Follow-up: product integration

The next bounded slice completed the explicit request journey without changing
the source experiment's boundaries:

- requests naming both UCR and enrollment route to this captured official
  snapshot;
- requests naming UCR without enrollment remain unsupported;
- the product validates the derived snapshot against the same typed schema the
  raw HTML parser produces before building;
- the dashboard carries no sensor plan, so the refinement surface is hidden;
- persistence records `ucr-institutional-research` and
  `deterministic-enrollment-v1`, then reopens the sealed bytes through the same
  `/d/[id]` path;
- the web product now imports `@dasher/enrollment-domain`, so its temporary
  unreachable declaration was removed.

The source is still a captured known source, not a live fetch or autonomous
research result. Source recommendation and current-period refresh remain later
product questions.

## Sources

[1] https://ir.ucr.edu/campus-facts-tables — UCR Campus Facts Tables
[2] https://ir.ucr.edu/sites/default/files/2026-05/cds-2025-2026.pdf — UCR Common Data Set 2025-26
[3] https://smartquery.ucr.edu — UCR Institutional Research SmartQuery
