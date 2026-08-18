# What wiring a live source exposed

Status: Recorded — one finding fixed, one limit stated
Date: 2026-08-18

## The parser could not read a real USGS response

`parseUsgsInstantaneousValues` required `value.queryInfo.creationTime`. The
live instantaneous-values service does not send that field. It reports when it
answered inside `queryInfo.note[]`, as an entry titled `requestDT`:

```json
{ "title": "requestDT", "value": "2026-08-18T22:29:20.423Z" }
```

Every live river request would have failed at the schema, on the first line of
the first fetch. Nothing caught it because nothing had ever handed that
function a real payload — the committed fixture is hand-authored, carries
`creationTime`, and was the only input the parser had ever seen.

A second, smaller instance of the same thing: the note `value` cap was sized
for a timestamp (64 characters), and real notes carry filter descriptions, a
request id, and a 118-character provisional-data disclaimer. That rejected
every live response too, one layer further in.

**Both are fixed, and a bounded verbatim capture is committed** at
`fixtures/usgs/live-capture-2026-08-18.json` — the real response trimmed to the
last four observations per series and otherwise untouched. `usgs.test.ts`
parses it and pins the retrieval time that comes out of the `requestDT` note.
The parser now accepts either shape and **rejects a payload carrying neither**,
because that timestamp becomes every station's `retrievedAt` and bounds the
future-observation check; defaulting it would be inventing provenance.

The hand-authored fixture stays as the development fixture. It carries a
deliberately degraded gauge that the freshness tests depend on, which a
verbatim capture cannot provide — a real response is whatever the river was
doing that minute.

## The OpenAQ loader asked the wrong question and would have been told "200"

A live check after review found the air path broken in a worse way than the
river path had been. The river defect was loud: a schema rejection on the
first fetch. This one was silent.

**The query form does not filter.** `/v3/locations?id=678,1289,627` returns
HTTP 200 and ignores the `id` parameter, answering with the first page of
every location OpenAQ knows about. Asking for three Sacramento monitors and
receiving a hundred arbitrary ones, with a success status, is worse than an
error: an error refuses, and this would have compiled a confident dashboard
about monitors on another continent.

**The identifiers were also wrong.** They had been carried over from the
hand-authored fixture, where they were invented. In the real API:

| Fixture claimed                    | Actually is                     |
| ---------------------------------- | ------------------------------- |
| `2178` Sacramento — Del Paso Manor | Del Norte (sensors: ozone, SO2) |
| `2183` Roseville — N Sunrise       | Denver                          |
| `2190` Woodland — Gibson Road      | Osceola County Fire Station     |

So the fixture did not merely invent readings — it asserted a false mapping
between an identifier and a place, and the loader inherited it.

**Both are fixed, and the second fix is the durable one.** The loader now
requests each location on its own endpoint (`/v3/locations/{id}`) and then
verifies that the response actually contains the location it asked for,
refusing otherwise. Correct identifiers are not enough: a 200 is not a
promise that a filter was honoured, so the check is on identity rather than
status, and the next filter this API decides to ignore fails closed too.

The verified Sacramento-area set, and the identities the fixture now carries:

| Location                       | PM2.5 sensor | Ozone sensor |
| ------------------------------ | ------------ | ------------ |
| `678` Sacramento — Downtown    | `1556`       | `1548`       |
| `1289` Arden Arcade — Del Paso | `2309`       | `2305`       |
| `627` Woodland — Gibson Road   | `1100`       | `1101`       |

The fixture's readings remain hand-authored — a real capture is whatever the
air was doing that minute, and the tests need a worsening monitor, an
improving one, and a degraded one — but its identities are no longer
invented.

## `limit=6` returns the OLDEST six records

The third defect, found by parsing the capture rather than by reading it.

`/v3/sensors/{id}/hours?limit=6` answers with six hourly values **from March
2016**, and reports `found: ">6"`. The endpoint paginates ascending from the
start of a sensor's history, so a "give me the latest six hours" query
written the obvious way returns the first six hours the sensor ever
recorded. A live air dashboard would have shown ten-year-old readings under
a heading about current conditions.

Nothing in the pipeline was wrong: the parser parsed, the compiler compiled,
and the freshness machinery correctly marked all three monitors as needing
attention. That is the system being honest about bad input — and it is also
why this was worth catching, because "3 monitors need attention" is a much
quieter symptom than a decade-old timestamp deserves.

The loader now sends `datetime_from` (a 24-hour window) **and**
`sort_order=desc`. Both, deliberately: the window says which hours are
wanted and the order says which end to take, so neither parameter being
honoured alone leaves the query silently ascending. **This fix is not
verified live** — it is written from the documented v3 API, and this
environment still has no credential to test it with.

## What the capture also showed about grouping

`locality` is the CBSA metro name, not the city: all three monitors report
`Sacramento--Arden-Arcade--Roseville`. So every monitor in one metro shares
a `group`, and a ranking labelled by group repeats one string three times.
The hand-authored fixture invented per-city localities and hid this.

It is not a parser defect — the parser reports what the source says — and it
is not fixed here, because the HOLD asked for the demonstrated mismatch and
nothing wider. It is a product question: what should label a station when
its domain's natural grouping is not distinctive?

## The bounded real capture, and what it is committed for

`fixtures/openaq/live-capture-2026-08-18.json` is now committed: the three
verified Sacramento-area monitors and their six sensor histories, assembled
from the per-location and per-sensor endpoints, credential-free — response
bodies and a retrieval time, no header, no key, no request metadata.
Scanned before committing.

It is kept **as captured, defect included**: the observations in it are the
2016 ones, because that is what the pre-fix query returned. Replacing them
with something tidier would erase the evidence. `openaq.test.ts` parses it
and pins both findings; `compile.air.test.ts` takes it through the shared
compiler under `AIR_COMPUTATION`/`AIR_WORDS` to a contract-valid dashboard.

**Still unproven from this repository:** the corrected query against the
live service. No `OPENAQ_API_KEY` exists here — `api.openaq.org` answers 401
— so `datetime_from` + `sort_order=desc` returning recent data is documented
behaviour, not observed behaviour. That is the one remaining item, and it
needs a credential rather than more code.

What that means, precisely:

- The **river** live path is proven against a real payload from the real
  service.
- The **air** live path has been corrected against real bytes at three
  points — endpoints, identifiers, and record ordering — plus a
  response-identity check that fails closed on the general case. The capture
  parses and compiles here. What remains unverified is the corrected query
  itself, which needs a credential this environment does not have.

That is a real gap and it is worth being blunt about: the same class of defect
this note opens with — a parser written against an idealised fixture, wrong
about reality in a way no test could see — remains possible on the air side.
It closes the day someone runs the air path once with a real key. The runtime
fails closed, so the failure mode if the shape is wrong is a refusal rather
than a wrong dashboard.

## What the runtime does with a failure

Nothing quiet. A fetch, status, size, or parse failure in live mode refuses the
request and persists nothing; there is no fixture fallback, because a dashboard
built from a committed sample and presented as current conditions is the one
outcome this product cannot have. Stale-but-valid data is different and is
allowed through: the freshness machinery marks it visibly, which is a truthful
answer rather than a refusal.
