# ADR-008: Evidence records how a value was obtained, and extraction must be verifiable

Status: Proposed
Date: 2026-08-19
Depends on: ADR-004, ADR-005, ADR-007
Prior evidence: `docs/process/2026-08-18-what-a-live-source-exposed.md`,
`docs/process/2026-08-19-ucr-enrollment-source-experiment.md`

## Context

Every number Dasher has ever rendered came from a hand-written parser over a
structured source: USGS, OpenAQ, and UCR's Campus Facts capture. For those, a
single correctness property holds the whole product up — the plan cannot
influence a number, so a model may choose framing and layout while trusted code
computes every value from parsed source data.

The product direction is wider than that. ADR-005 already records it: Dasher is
"a multi-dashboard workspace, not a one-request, one-dashboard generator," and
the agentic harness is a core capability rather than a later nicety. The owner
has since named two consequences of that direction explicitly: dashboards should
draw on **multiple data sources at once**, including connected MCP servers, and
the model should be able to **research the open web** to populate a dashboard
where no connector exists.

Web research collides head-on with the property above. If a model reads a page
and reports that UC Riverside enrolled 27,633 students, the model produced a
value. "Trusted code computes every value" is no longer true as stated, and the
honest options are to abandon the property or to find the narrower true version
of it.

This ADR records the narrower version, and the vocabulary the contract needs to
express it.

## Decision

**A value's provenance tier is part of the evidence contract, and it decides
what that value may become.**

`EvidenceSchema` gains two fields:

| Field  | Meaning                                                                           |
| ------ | --------------------------------------------------------------------------------- |
| `tier` | `parsed` \| `extracted` \| `asserted` — how the value was obtained                |
| `span` | The exact retained source text a value was read out of. Required for `extracted`. |

`kind` (`observed` / `calculated` / `interpreted` / `recommended`) is unchanged
and answers a different question: what sort of claim this is. `tier` answers how
much the claim can be trusted to correspond to a source. Today `observed` means
both "a sensor reported it" and "a webpage said it," and those are not the same
claim.

### The three tiers

**`parsed`** — a structured source (API, MCP tool result, captured fixture) read
by a deterministic parser, with values computed by trusted code. Everything in
the product today is this tier. Verifiable by construction.

**`extracted`** — a model read a fetched document and pulled a value out of it.
Verifiable _by check_: this is the tier that makes research tractable, and the
rules below are what make it a check rather than a hope.

**`asserted`** — a model stated something that is not present in any retained
document. Not verifiable.

### The rules

1. **An extracted value must appear verbatim in its retained span, and the span
   must appear verbatim in the retained document.** Trusted code performs both
   comparisons. A value that fails either is refused — not downgraded, not
   flagged, not rendered with a caveat. Refused.

2. **A calculated fact inherits the lowest tier of its inputs.** If "enrollment
   rose 4.7%" is computed from two extracted numbers, it is an extracted fact and
   must be displayed as one.

3. **`asserted` values carry no numeric authority and may never feed a
   calculation.** An asserted claim may appear as framing or narrative under
   `interpreted`, at low confidence, and nothing may be derived from it.

4. **Research is a Dasher-run source job**, separately authorized, never a
   provider-hosted tool. The inference provider stays inference-only.

5. **Fetched content is data, never instruction.** Page text, MCP tool names,
   tool descriptions, and tool results are attacker-controllable on any source
   Dasher does not own. None of it may enter a planner prompt unquoted, and none
   of it may alter authorization, routing, or what gets computed.

6. **The tier is visible to the reader.** A dashboard mixing tiers must show
   which is which. The existing `Observed · Calculated` badges are the affordance.

Rule 1 is the load-bearing one, and it is why this direction is tractable at all.
Extraction is closer to transcription than to reasoning, and transcription can be
checked against the thing transcribed. Nothing checks reasoning.

## What ADR-004 and ADR-005 already decided, and one correction

This ADR **adds to** ADR-004 and ADR-005. It amends neither. That is worth
stating because the additions were nearly written as amendments on the strength
of a misreading.

ADR-004 says: "Disable **provider-hosted** web search, code interpreters, file
tools, remote MCP, and other tools. Provider requests are inference-only." That
was read as prohibiting web research. It is not: it prohibits the _model
provider_ reaching the network on Dasher's behalf. ADR-004 goes on to say that
"research or tool use is a new separately authorized source job" — so research
was already contemplated, in the shape rule 4 above restates.

ADR-004 likewise already specifies what "prepackaged MCP" means: "a named remote
HTTPS server from an administrator-approved catalog," with the approved revision
pinning URL, publisher, authorization, egress, tool names, descriptions, schemas,
hashes and scopes; discovery in quarantine; manifest drift disabling the
connection. An administrator-approved catalog _is_ a prepackaged catalog.
Brokering is how such a catalog is delivered safely, not an alternative to it.
Nothing there limits a dashboard to a single connector.

The one genuine boundary is that "tenant-supplied servers are outside the pilot."
Letting a user point Dasher at an arbitrary MCP URL is a distribution feature —
it changes who may add a source, not what the product can do — and it needs its
own ADR when wanted.

## Why this changes what an unsupported request does

Today `classifyRequest` in `apps/web/app/domains.ts` returns
`{ kind: "unsupported" }` for a request naming no known domain, and the request
is refused. That was correct while every source needed a hand-written parser.

With a verified extraction tier, an unconnected request has a second possible
answer: build the dashboard from research, at a visibly lower tier, with
citations. Connectors give high-trust, live, cheap-to-refresh, narrow coverage;
research gives lower-trust, snapshot, expensive, unlimited coverage. Graceful
degradation instead of a closed door — and it stays honest only because rule 6
puts the tier on the page.

Fail-closed does not weaken. It moves from _unsupported_ to _unverifiable_: a
request Dasher cannot answer from a connector **or** from verifiable extraction
is still refused.

## Intake currently rejects the target state

Also in `domains.ts`: a request matching more than one domain returns
`{ kind: "ambiguous" }` and is refused. That rule exists for a good reason — it
is what stops "UC Riverside enrollment" from silently producing a Sacramento
river dashboard — but under a multi-source product, a request touching two
sources is the _goal_, not an error.

The resolution is that intake must return a **set of source bindings** rather
than one domain. Fail-closed is preserved by refusing the **unresolvable**, not
the **plural**.

## Two refresh contracts

A gauge re-fetches hourly and returns the same shape. A researched fact may not
be re-derivable identically: the page changed, or the model reads it differently.
These are different guarantees and a dashboard must know which of its facts are
which — **monitored** or **researched**. A researched dashboard is a snapshot
with citations, and refreshing it means re-running extraction and re-verifying,
not assuming the previous answer still holds.

## Evidence stops being only justification

On the river dashboard, "View evidence" argues: here is why this number is what
it is. On a researched dashboard it also navigates: open the page this came from.
Same mechanism, different verb. This is a display consequence rather than a
contract change, and it is recorded because it argues for making evidence a
primary click target rather than a modal — which would improve the parsed tier
too.

## Recorded observation: three organizing shapes

Not a decision. Recorded because it came out of examining what the contract
cannot currently express, and because the next contract change will have to
confront it.

`Station` is not a general shape that rivers happen to fit; it is a measurement
station with the words removed — required latitude and longitude, `rising` /
`falling` / `steady`, `fresh` / `stale` / `missing`. Air-quality monitors were an
easy second case because they are the same shape. Examining P&L, supply
shipments, and a personal digest suggests three organizing shapes rather than one:

| Shape                     | What it is                                      | Status                                                       |
| ------------------------- | ----------------------------------------------- | ------------------------------------------------------------ |
| **Population**            | N comparable things, each with a current value  | Built (`Station`)                                            |
| **Composition**           | one whole decomposed into parts that sum        | Not built — a P&L cannot say "these parts add to this whole" |
| **Commitments over time** | items with a time, a state, and often a promise | Not built — shipments, calendar, reminders, SLAs             |

The UCR experiment (#32) gave the first real evidence here: `summary`,
`metric-grid`, `ranking`, evidence and the brief were sufficient for a
non-station domain, and it recorded two costs — top-level `freshness` is
sensor-biased, and `trend-list` requires ISO timestamps while the source reports
"Fall 2025", so the ten-year trend was omitted rather than fabricated. That
second cost blocks the time axis for every non-sensor domain and is the smallest
concrete thing this taxonomy predicts.

## Cost: the schema version

Adding `tier` and `span` to `EvidenceSchema` is a dashboard-contract change and
moves `schemaVersion` past `1.2`. ADR-007 set the expectation that this would be
the expensive one:

> "If real dashboards exist at the _next_ contract change, this option is gone:
> that change pays for either a migration or a multi-version renderer."

`README.md` still records "Production deployment: not performed." If that is
still true when this is implemented, dropping the old version remains available
and should be taken; if it is not, this change pays ADR-007's price. This is the
dashboard contract in `@dasher/dashboard-schema`, not the database schema, so
ADR-006's migration tiers are unaffected — the same distinction ADR-007 drew.

## What deliberately does not change

- **The plan cannot influence a number.** Narrowed, not abandoned: the model may
  propose _structure_ — which sections, which framing, and which field of a
  document holds which value — and trusted code performs every computation and
  every verification. A model proposing a mapping is not a model producing a
  value.
- **`kind` and `confidence`.** Both stay. `tier` is orthogonal to `kind`, and
  `confidence` is not a substitute for it: a webpage can be quoted with high
  confidence and still be a webpage.
- **The plan vocabulary.** `PLAN_SECTION_KINDS` remains river-worded, per
  ADR-007. Renaming it still invalidates the recorded eval corpus for no
  structural gain, and doing it as a side effect of this decision would be worse
  than doing it deliberately later.
- **Tenant-supplied MCP servers.** Still outside the pilot, per ADR-004.
- **Generated-code execution.** Still `CLOSED`.

## Not decided here

- Which extraction mechanism proposes candidate values, and how its output is
  schema-bound.
- Whether verification is exact-substring only, or admits normalisation for
  thousands separators, unicode dashes, and whitespace. This is the first thing
  the implementation spike must answer with real pages, because too strict
  refuses correct values and too loose is not a check.
- SSRF policy specifics for model-chosen URLs: scheme and host allowlisting,
  private-range blocking, redirect handling. ADR-004's `SafeSourceUrlSchema`
  already refuses credential-bearing and non-HTTP(S) source URLs and is the
  starting point, not the finished rule.
- Per-user credentials for authenticated sources such as mail and calendar.
- Retention and size limits for retained spans and documents.

## Proving it

The learning question for the first implementation slice is deliberately narrow:
**does verbatim verification work, and what does it reject?** The rejections are
the finding — the same way the live-source slice's value was the three silent
defects rather than the working path.

That slice should prove extraction offline against captured real pages, with a
source/retrieval/hash sidecar as the UCR experiment used, before any live search,
routing change, or display work. Everything else in this ADR is tractable once
rule 1 holds, and worthless if it does not.
