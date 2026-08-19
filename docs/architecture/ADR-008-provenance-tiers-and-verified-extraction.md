# ADR-008: Provenance is a property of claims, and extraction must be verified at coordinates

Status: Proposed
Date: 2026-08-19
Depends on: ADR-004, ADR-005, ADR-006, ADR-007
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

This ADR records the narrower version, the vocabulary the contract needs to
express it, and — explicitly — the part of the gap it does **not** close.

## Decision

**Provenance is a property of a claim, not a decoration on an evidence record,
and it decides what that claim may become.**

### Where provenance lives

Evidence remains what ADR-005 says it is: "support artifacts, not semantic
Claims" — a retained, immutable thing that was actually retrieved. Model output
with no retained source is therefore **not evidence**, and must not be
represented as an evidence record. Doing so would require inventing a
`sourceName` and a `retrievedAt` for something that was never sourced or
retrieved, which is a fabrication written into the trusted layer.

So the contract splits along the split the database already has:

| Layer                        | Gains                                                                                                          |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Evidence (retained support)  | `tier`: `parsed` \| `extracted`. Nothing else. There is no `asserted` evidence, because there is no artifact.  |
| Claim (the semantic binding) | a provenance state: `parsed` \| `extracted` \| `unsupported`, derived from the evidence supporting that claim. |

`unsupported` is the state a model assertion occupies. This is not a new idea
being introduced here — `dasher.claims` in `0001_baseline.sql` already carries
`evidence_state IN ('complete', 'partial', 'contradicted', 'stale',
'unsupported')` alongside `label IN (… 'hypothesis', 'recommendation', …)`, and
`claim_evidence` already carries `supports` / `contradicts` / `context` edges.
The vocabulary exists; this ADR binds the dashboard contract to it rather than
inventing a parallel one on the evidence side.

The dashboard contract consequence is a diagnosis rather than a feature. Today
`RequiredEvidenceIdsSchema` admits only a non-empty list, so the only way to put
an unsupported narrative claim on a dashboard is to fabricate an evidence record
for it. This ADR closes that by forbidding the fabrication — not by opening a
rendering path. Rule 3 keeps unsupported output off the page entirely until the
contract grows an explicitly non-material projection, because under ADR-005 an
`interpreted` or `recommended` label is not a place to park it.

`kind` (`observed` / `calculated` / `interpreted` / `recommended`) is unchanged
and answers a different question: what sort of claim this is. Provenance answers
a narrower one: whether the claim rests on a retained artifact at all, and — if
it does — how the source characters were turned into it. It does **not** say
that the claim corresponds to its source; source authority and semantic
correctness are separate dimensions, kept separate below. Today `observed` means
both "a sensor reported it" and "a webpage said it," and those are not the same
claim.

### The tiers name one dimension only

The tier answers exactly one question: **how faithfully did the value get from
the retained artifact into the claim?** Call that dimension _transformation
integrity_. It is not a trust score, and the tiers are not a total ordering of
how much a number deserves to be believed.

**`parsed`** — a structured source (API, MCP tool result, captured fixture) read
by a deterministic parser, with values computed by trusted code. Every
source-derived numeric value in the product today is this tier — not everything
on the page, since the planner already emits `interpreted` narrative
(`packages/planner/src/compile.ts`) that is not a parsed source value.
Deterministic by construction.

**`extracted`** — a model read a retained document and proposed a value out of
it, and trusted code verified that value at recorded coordinates in that
document. Coordinate-verified, semantically unverified; the limits are below and
they are not small.

**`unsupported`** — a model stated something present in no retained document.
Not verifiable, carries no numeric authority, and is a claim state rather than
an evidence record.

`parsed` establishes nothing about source identity, authority, freshness, or
completeness. Dasher has its own proof of this, and it is unambiguous. The live
OpenAQ slice parsed every response faithfully while the API silently ignored the
`id` filter and answered with arbitrary locations, while three station
identifiers pointed at Del Norte, Denver, and an Osceola County fire station
instead of Sacramento, and while an hourly endpoint paginating ascending
returned readings from March 2016 under a heading about current conditions. The
write-up's own summary is the point:
`docs/process/2026-08-18-what-a-live-source-exposed.md` — "Nothing in the
pipeline was wrong: the parser parsed, the compiler compiled."

The converse holds too. A model extracting from a correctly identified,
authoritative, current official document has **stronger source authority** than
a parser reading a misidentified feed, and weaker transformation integrity. Both
statements are true at once, which is only expressible if the dimensions stay
separate.

So these stay orthogonal and none of them collapses into another:

| Dimension                | Answers                                                       | Carried by                              |
| ------------------------ | ------------------------------------------------------------- | --------------------------------------- |
| Transformation integrity | how the value got from artifact to claim                      | `tier` (this ADR)                       |
| Source authority         | whether this source may speak to this subject at all          | connector approval, retrieval identity  |
| Freshness                | how old the artifact is, and whether a newer retrieval exists | `observedAt` / `retrievedAt`, policy    |
| Artifact integrity       | whether the sealed bytes are still the sealed bytes           | `content_sha256`, fail-closed           |
| Evidence completeness    | whether the supporting set covers the claim                   | ADR-005's `complete` / `partial` states |
| Confidence               | the stated strength of the claim                              | `confidence`                            |

Integrity is listed separately from freshness on purpose. `source_snapshots` is
immutable and its `content_sha256` is constrained to equal
`sha256(canonical_bytes)`, so a hash mismatch is not an aged artifact — it is
corruption or tampering, and it **fails closed**. A claim goes stale because of
observed or retrieved age, a retention or refresh policy, or a newer retrieval
superseding it. Those are different events with different responses, and
collapsing them would turn an integrity failure into a routine refresh prompt.

### What the verifier actually operates on

`tier` and `span` as two display fields on an evidence record cannot enforce
any of this, and the first draft of this ADR wrongly implied they could. A
dashboard evidence item may support several different values, carries no
immutable snapshot identity, no content hash, and no coordinates, and holds no
explicit extracted value. Verifying by searching a document for a string proves
only that the string occurs somewhere in it — not which occurrence, and not
which claim field it was bound to.

Verification therefore operates on a typed **extraction candidate**, not on the
rendered spec. A candidate must name, at minimum:

| Part              | Why                                                                         |
| ----------------- | --------------------------------------------------------------------------- |
| `snapshotId`      | which retained document, immutably                                          |
| `contentSha256`   | that the document has not changed since retrieval                           |
| `locator`         | exact coordinates within it — byte or character offsets, plus any node path |
| `extractedText`   | the literal characters at those coordinates                                 |
| `value` + `unit`  | the typed value the model proposes those characters denote                  |
| `subject`         | what the value is about                                                     |
| `field`           | which measured property of that subject                                     |
| `reportingPeriod` | the period the source attributes it to                                      |
| `claimPointer`    | the JSON pointer into the spec this candidate is bound to                   |

Trusted code then verifies **at the coordinates**: re-hash the snapshot, read the
locator, and require that what is there equals `extractedText`. A candidate whose
text exists elsewhere in the document but not at its stated coordinates is
**refused**, and that negative case is a required test, not an incidental one —
it is the difference between checking a citation and checking a search hit.

The relationship between `extractedText` and `value` is then checked under a
deliberately narrow, deterministic definition: a **versioned lexical
normalisation** turns the source characters into a token and a unit syntax, and
the check is that `value` and `unit` are that token and that syntax. It decides
that the characters `27,633` are the integer 27633, and that `4.7%` is a
percentage rather than a count. It decides nothing about what the number is _of_.

This is stated as a definition rather than left to the word "denotes" because
"denotes" would smuggle in exactly the semantic verifier the next section says
does not exist. Normalisation is versioned because widening it — thousands
separators, unicode dashes, non-breaking spaces — changes what verifies, and a
change of that kind must be a visible contract revision rather than a quiet
loosening.

These are the same primitives the durable graph already provides:
`source_snapshots.content_sha256` (constrained to equal
`sha256(canonical_bytes)`), `evidence_records.snapshot_id` + `coordinates` +
`transformation`, `claims.json_pointer` + `assertion_sha256`, and the
`claim_evidence` edge. **None of them are populated today**: the web save path in
`packages/control-plane/src/dashboard-repository.ts` stores canonical spec bytes
and passes a literal `"[]"` for claims. Making extraction verifiable means
writing that graph, not adding two fields to a rendered spec.

### The rules

1. **An extracted value must verify at its recorded coordinates in a retained,
   hash-checked snapshot.** Trusted code performs the comparison. A candidate
   that fails is refused — not downgraded, not flagged, not rendered with a
   caveat. Refused.

2. **A calculated fact inherits the lowest transformation integrity of its
   inputs, and preserves the rest of the provenance vector.** "Lowest" is
   well-defined only on the one ordered dimension named above
   (`parsed` > `extracted` > `unsupported`); it says nothing about the source
   authority, freshness, or completeness of the inputs, and those travel with
   the result rather than being flattened into it. If "enrollment rose 4.7%" is
   computed from two extracted numbers it is an extracted fact and must be
   displayed as one — and if one input is a year stale, the result is a year
   stale too, regardless of tier. A calculation with any `unsupported` input is
   refused (rule 3), not merely marked.

3. **Unsupported output is confined to explicitly non-material framing.** It
   carries no numeric authority, may never feed a calculation, and carries no
   evidence ID and no fabricated one. Labelling it `interpreted` or
   `recommended` does **not** license it: ADR-005 says "every material claim and
   calculated value must resolve through typed transformations to authorized
   immutable evidence. Interpretation and recommendation labels do not substitute
   for evidence." A recommendation is frequently the most material thing on a
   dashboard, and low confidence does not make it less so.

   So the boundary is materiality, not label. Unsupported output may appear only
   as explicit hypothesis or explicit unknown — "no source was found for this",
   "one reading of this would be" — and never on a decision-bearing surface: not
   as a metric, not in a ranking, not in an alert, not in the brief's findings.
   The database already has this vocabulary in `claims.label` (`hypothesis`) and
   `claims.evidence_state` (`unsupported`). The dashboard contract does not: its
   `kind` vocabulary has no non-material projection, and adding one is a future
   contract question this ADR names rather than settles. **Until it exists, the
   conservative reading holds — unsupported output does not render.**

4. **Research is a Dasher-run source job**, separately authorized, never a
   provider-hosted tool. The inference provider stays inference-only.

5. **Source content may supply operands; it may never select operations or
   authority.** Page text, MCP tool names, tool descriptions, and tool results
   are attacker-controllable on any source Dasher does not own. Saying such
   content must not change "what gets computed" would be incoherent — source
   values necessarily change results; that is what a data source is for. The
   enforceable line is between operand and operation:

   | Source content may                           | Source content may never                              |
   | -------------------------------------------- | ----------------------------------------------------- |
   | supply bounded, typed, schema-checked values | select the operation graph, or which calculation runs |
   | populate a claim it is bound to              | select tools, capabilities, scopes, or destinations   |
   | contradict an existing claim                 | trigger follow-on fetches or widen egress             |
   |                                              | affect authorization, tenancy, routing, or lifecycle  |

   Quoting and delimiting are not the control and this ADR does not claim they
   are. The controls are typed channels, an allowlisted operation set,
   deterministic authorization that reads only trusted context, and an isolated
   extraction role with no tools, no network, and no authority to route,
   authorize, or commit. Planners never receive raw document text — they receive
   accepted typed candidates and evidence IDs.

6. **Provenance is visible to the reader through its own affordance.** The
   existing `Observed · Calculated` badge renders `item.kind` and nothing else
   (`apps/web/components/dashboard-shell.tsx`), so it cannot carry this. Reusing
   the badge _region_ is fine; reusing the badge's existing _meaning_ is not. A
   dashboard mixing provenance must show which value is which, distinctly from
   `kind`.

### The visible and enforceable matrix

| Question                                          | Decision                                                                                                                                   |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| May a `parsed` evidence record carry coordinates? | Yes — required. `evidence_records.coordinates` is `NOT NULL`, and parsed evidence names its source JSON path or record coordinate.         |
| May a `parsed` evidence record carry a span?      | No. `extractedText` and its locator are extraction-specific; a parser's authority is its code under test, not a quotation.                 |
| Which `kind`s may an `unsupported` claim take?    | None today. Per rule 3 it needs a non-material projection the contract does not yet have; `interpreted` / `recommended` do not substitute. |
| How does a claim's provenance derive?             | The lowest tier among the evidence records that `support` it; `unsupported` when there are none.                                           |
| A calculation over mixed `parsed` and `extracted` | Displays as `extracted` (rule 2), and names both sources in its evidence.                                                                  |
| A claim supported by several evidence IDs         | Same lowest-tier rule, on the tier dimension only. Adding a `parsed` citation beside an `extracted` one never raises it.                   |
| A `contradicts` edge                              | Out of scope here; ADR-005's `contradicted` state governs it and this ADR does not weaken it.                                              |

## What coordinate-verified extraction does not prove

Verification at coordinates proves **lexical grounding**: these characters really
are in that document, at that place, unchanged since retrieval. It does not prove
the **semantic mapping**, and the mapping is model-authored.

A span reading `27,633 applications; 24,034 enrolled` verifies perfectly for a
candidate that binds `27,633` to enrollment. Both checks pass; the dashboard is
wrong. The same failure is available on subject (a different campus in the same
table), on reporting period (Fall 2024 in a page about Fall 2025), on unit
(thousands vs units), and on denominator (a rate over the wrong base). Rule 2
then propagates the mis-bound number into every calculation derived from it,
with full provenance display, looking exactly like a correct one.

Requiring the candidate to name `subject`, `field`, `unit`, and
`reportingPeriod` is what makes this mapping _inspectable_ — a reviewer, or a
later cross-check, can see what the model claimed the characters meant. It does
not make it _verified_. So:

- "Extracted is verifiable" is an overstatement, and is not claimed here.
  Extracted is _coordinate-verified and semantically unverified_.
- There is no total truth ordering in which `parsed` and `extracted` differ only
  by degree. They differ in kind: a parser's mapping is code under test, and an
  extraction's mapping is a model's proposal that nothing checks. And per the
  dimension table above, neither ordering speaks to source authority — a
  faithful parse of a misidentified feed is worse than a coordinate-verified
  extraction from the right document.
- The first spike must therefore measure **false acceptances** — candidates that
  verify and are still wrong — and not only rejections. A spike that reports only
  its rejection rate is measuring the easy half.

## What ADR-004 and ADR-005 already decided

This ADR **adds to** ADR-004. Against ADR-005 it is additive as long as evidence
stays retained support, which is why `asserted` was moved off the evidence
record: ADR-005 requires that "every material claim and calculated value must
resolve through typed transformations to authorized immutable evidence," and
calling a model's unsourced sentence "evidence" would have contradicted that
while claiming to amend nothing.

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

With a coordinate-verified extraction tier, an unconnected request has a second
possible
answer: build the dashboard from research, at a visibly lower tier, with
citations. The two differ in governance and shape, not in how true they are —
neither delivery method establishes truth, and the earlier dimension table is
what keeps that straight. Connectors are connector-governed and monitored:
approved source identity, live, cheap to re-fetch, narrow. Research is
snapshot-grounded: coordinate-verified against retained bytes, semantically
unverified, expensive, and reaching sources no connector covers — which is
broader access, not unlimited access, since SSRF policy and source approval
still bound it. Graceful degradation instead of a closed door, and it is honest
only because rule 6 puts the provenance on the page.

Fail-closed does not weaken. It moves from _unsupported_ to _unverifiable_: a
request Dasher cannot answer from a connector **or** from coordinate-verified
extraction is still refused.

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
with citations, and refreshing it means re-running extraction and re-verifying
at fresh coordinates, not assuming the previous answer still holds.

Two failures live here and must not be confused. A claim goes **stale** when its
artifact ages past policy, or when a newer retrieval supersedes it; the response
is to re-retrieve and re-verify. A snapshot whose `content_sha256` no longer
matches its bytes has suffered an **integrity failure** — the store is immutable
and hash-constrained, so this is corruption or tampering, never age. The response
is to fail closed on every claim resting on that snapshot, not to refresh it.

## Evidence stops being only justification

On the river dashboard, "View evidence" argues: here is why this number is what
it is. On a researched dashboard it also navigates: open the page this came from,
at the place it came from. Same mechanism, different verb. This is a display
consequence rather than a contract change, and it is recorded because it argues
for making evidence a primary click target rather than a modal — which would
improve the parsed tier too.

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

Adding a provenance tier to `EvidenceSchema`, and an explicit unsupported state
to claim-level evidence references, is a dashboard-contract change and moves
`schemaVersion` past `1.2`. ADR-007 set the expectation that this would be the
expensive one:

> "If real dashboards exist at the _next_ contract change, this option is gone:
> that change pays for either a migration or a multi-version renderer."

`README.md` records "Production deployment: not performed." That is a statement
about deployment, not about persisted bytes, and it is **not** sufficient
evidence that dropping `1.2` is free. Development, staging, demo, and test
environments can hold rows in `dashboard_versions` under retention obligations
just as production would.

So the decision is conditional and the condition is a census, not a label:
before dropping `1.2`, count the persisted `dashboard_versions` rows at each
`schemaVersion` in **every** environment with a retention obligation. If the
count is zero everywhere, drop it. If it is not, this change pays ADR-007's
price — a migration or a multi-version renderer — and the census output is the
record of why.

This is the dashboard contract in `@dasher/dashboard-schema`, not the database
schema, so ADR-006's migration tiers are unaffected — the same distinction
ADR-007 drew. Populating `source_snapshots`, `evidence_records`, `claims`, and
`claim_evidence` for the first time _is_ database work, but those relations
already exist in `0001_baseline.sql`; writing rows to an existing empty table is
not a migration.

## What deliberately does not change

- **The lexical invariant**, which replaces "the plan cannot influence a number"
  rather than preserving it by definition. The old sentence is not true under
  extraction and cannot be rescued: choosing the mapping chooses which source
  number becomes the displayed value, and this ADR's own example proves it —
  binding `27,633 applications` to enrollment changes the enrollment figure on
  the page while every coordinate check passes. Calling that "proposing
  structure, not producing a value" is a definitional dodge.

  What survives is narrower and lexical, not causal: **a model cannot introduce
  numeric content that is absent from retained coordinates or from trusted
  computation.** Every digit on the page traces to bytes someone retrieved and
  sealed, or to a calculation trusted code performed over such bytes. The model
  can still select — and misbind — which grounded number lands in which field,
  and that mapping is semantically unverified. Trusted code still performs every
  computation and every coordinate check. It does not check the mapping, and no
  sentence in this ADR should be read as claiming otherwise.

- **`kind` and `confidence`.** Both stay. Provenance is orthogonal to `kind`, and
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
- The exact locator format — byte offsets, character offsets, or a DOM/node path
  plus offset — and how it survives a document being canonicalised on retrieval.
- Whether verification is exact-substring only, or admits normalisation for
  thousands separators, unicode dashes, and whitespace. This remains the first
  thing the implementation spike must answer with real pages, because too strict
  refuses correct values and too loose is not a check.
- Whether anything can be done to check semantic mapping cheaply — a second
  independent extraction, a structural cross-check against a neighbouring label —
  or whether it stays a stated limit.
- SSRF policy specifics for model-chosen URLs: scheme and host allowlisting,
  private-range blocking, redirect handling. ADR-004's `SafeSourceUrlSchema`
  already refuses credential-bearing and non-HTTP(S) source URLs and is the
  starting point, not the finished rule.
- Per-user credentials for authenticated sources such as mail and calendar.
- Retention and size limits for retained spans and documents.

## Proving it

The learning question for the first implementation slice has two halves, and
only reporting the first half would be measuring the easy one:

**Does coordinate verification work — what does it reject, and what does it
wrongly accept?**

The rejections are one finding, the same way the live-source slice's value was
the three silent defects rather than the working path. The false acceptances are
the other, and they are the finding that decides whether extraction is a tier
this product can ship at all: candidates that hash-match, verify at coordinates,
and still bind the wrong subject, field, period, unit, or denominator. Measuring
them needs hand-labelled ground truth over the captured pages, which is why the
spike stays offline.

That slice should prove extraction offline against captured real pages, with a
source/retrieval/hash sidecar as the UCR experiment used, before any live search,
routing change, or display work.
