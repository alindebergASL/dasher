# Is the compiler river-shaped, or just river-worded?

Status: Answered — spike run, result recorded, refactor not started
Date: 2026-08-18

## The question

The open item from the project review was whether Dasher generalises. Every
review of the roadmap has ended at the same sentence:

> What caps dashboard variety is not the planner: eight section kinds, one
> domain (`compilePlan` is written against `RiverGauge`), one fixture source.

That was accurate and useless. "Written against `RiverGauge`" could mean the
compiler is a river dashboard that happens to be code, or it could mean it is a
general dashboard compiler with river nouns. Those have wildly different costs
and nobody had checked which one it is.

## The method

Take a genuinely non-river source and push it through the **existing,
unmodified compiler**. Nothing in `packages/` was edited to make the spike run.
That constraint is the whole experiment: if the dashboard contract accepts the
output, the structure is already domain-neutral, and whatever is left is
vocabulary.

The source is air-quality monitoring stations — AQI as the primary reading,
PM2.5 as the secondary, six hourly observations each, three stations across two
regions, one worsening, one improving, one steady, plus a threshold rule.

**Why air quality and not something further away.** It is another network of
geolocated sensors reporting a time series, which means it exercises `gauge-map`
and `gauge-table` — the only two of the seven dashboard components that embed
domain field names. A domain that dodged those two would have let this note
declare success without touching the coupled part. It is also a sympathetic
choice, and the limits section below says what it therefore does not establish.

The spike itself is deliberately not committed. It is a throwaway that presents
air-quality data as `RiverGauge[]`, and keeping it would put a permanent lie in
the repository to prove a one-time point.

## The result

It compiled. `parseDashboardSpec` accepted the output, and all seven component
kinds were produced:

```
summary, metric-grid, gauge-map, gauge-table, ranking, trend-list, alert-list
```

So did the executive brief, the freshness block, the architecture panel, the
evidence records, and the threshold alert. **No structural change was needed to
compile a dashboard for a domain the compiler had never seen.**

That answers the question. `GaugeMetrics` is a primary reading, a secondary
reading, changes over three windows, a direction, a freshness state, a list of
data issues, and a series of points. `RiverFacts` is a partition of those into
rising, falling, stale, and ranked, plus alerts and evidence. Neither is river
shaped. Five of the seven components in `dashboard-schema` — `summary`,
`metric-grid`, `ranking`, `trend-list`, `alert-list` — contain no domain
vocabulary at all.

**The coupling is nominal, not structural.** It is a naming problem wearing a
architecture problem's clothes.

## What it cost to say that, and what is left

110 of the 334 strings in the compiled air-quality dashboard carry river
vocabulary, across 33 distinct paths. That is the refactor, and it is not a
rename, because it splits into four kinds of work with very different prices:

| Kind                      | Where                                                                         | Cost                                                                                                                  |
| ------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Prose the compiler writes | ~46 string literals in `compile.ts`                                           | A noun-set threaded through `CompileOptions`. Mechanical.                                                             |
| Fact-layer prose and ids  | ~15 in `facts.ts`, `metrics.ts`                                               | Same, plus `gaugeEvidenceId` hardcodes a `usgs-` prefix.                                                              |
| Plan vocabulary           | `PLAN_SECTION_KINDS`, `plan.siteIds`, `ThresholdRule.stageAbove`              | A plan-contract change. Every probe, eval artifact, and provider prompt names these.                                  |
| Dashboard contract        | `GaugeSchema`'s `river`, `stage`, `stageUnit`, `streamflow`, `streamflowUnit` | A **schema version bump**. `gate-contracts.test.ts` is 2,534 lines and persisted specs are stored as canonical bytes. |

The first two are a day. The third is a day and invalidates the committed eval
corpus's plan shape. The fourth is the real cost and the real decision, because
`schemaVersion` is what persisted dashboards were sealed under — `/d/[id]`
renders stored bytes, so a contract change means either a migration or a
renderer that understands two versions.

**So: not a rewrite. Closer to three days than to half of one, and the third
day is a contract decision rather than typing.**

## One defect the spike found

The air-quality dashboard reported `+7 ft`.

Six sites in `compile.ts` wrote `"ft"` as a literal while two others read the
unit from the series, so one dashboard could label the same gauge's change two
different ways. It was never reachable through the fixture path:
`parseUsgsInstantaneousValues` rejects a stage series that is not in feet, which
made every literal accidentally correct.

That is a fact about the parser, not about the compiler. `compilePlan` takes
`RiverGauge[]`, and a gauge in metres satisfies that type — the parser is not in
its call path. Fixed in the same change as this note, with four tests entering
through the signature the compiler actually publishes; reverting `stageUnit` to
the old literal turns three of them red. The air-quality run now reports
`+7 AQI`, and no bare `ft` survives anywhere in it.

Worth stating plainly: the compiler's own suite passed before and after, because
for rivers the behaviour is identical. The test that mattered was the one that
stopped using the fixture.

## What this does not establish

- **The domain was chosen sympathetically.** Air quality is geolocated sensors
  reporting a time series, which is the shape `GaugeMetrics` already has. A
  domain with no coordinates breaks `gauge-map` outright; one with no time
  series breaks `stage-trends` and every change window. The finding is that the
  compiler generalises across _sensor networks_, which is a narrower claim than
  "it generalises".
- **It says nothing about the planner.** `FakePlanningProvider` selects gauges
  by river name and station keywords, and `anthropic.ts` describes river gauges
  in its prompt. Compiling an air-quality dashboard proves nothing about
  anything being able to plan one.
- **The eight section kinds are still eight.** A domain needing a different
  visualisation — a map with regions rather than points, a distribution, a
  status timeline — is a new component in the contract, which is the schema-bump
  cost again. Generality of _shape_ is not variety of _output_.
- **No air-quality parser exists.** The spike constructed typed objects
  directly. A real second source needs its own `usgs.ts` equivalent, which is
  where the validation and provenance work actually lives — `usgs.ts` is 245
  lines and most of it is refusing malformed input.

## Recommendation

Do not start the rename. The first two rows of the table are cheap but pointless
on their own: renaming `gauge` to `entity` throughout, with one domain in the
repository, is churn that makes every existing test diff and buys nothing until
a second domain exists.

The order that pays is the reverse of the obvious one:

1. **Decide the contract question first.** Whether `GaugeSchema` becomes generic
   is a `schemaVersion` decision, and it is cheapest now, while exactly one
   dashboard has ever been persisted outside a test.
2. **Then write a real second-source parser**, because that is the work the
   spike skipped and the only part whose cost is still unmeasured.
3. **Then the vocabulary**, which by then has two callers to answer to and will
   fall out almost mechanically.

Doing (3) first is the version of this that feels productive and generalises
nothing.
