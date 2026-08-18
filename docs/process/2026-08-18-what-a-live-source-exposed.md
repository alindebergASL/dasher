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

## The bounded real capture is still not committed here

The slice called for committing one bounded real OpenAQ v3 response. **This
environment still cannot produce one.** `api.openaq.org` answers `401`
without an API key, and no `OPENAQ_API_KEY` is available here. The live
evidence above came from a reviewer running the check elsewhere; the
corrections are made from that evidence, and the capture itself remains to be
committed by whoever holds a credential.

What that means, precisely:

- The **river** live path is proven against a real payload from the real
  service.
- The **air** live path's request construction has now been corrected against
  live evidence — endpoints, identifiers, and the response-identity check —
  and the reviewer confirmed the real payloads parse through
  `parseOpenAqHourlySnapshot` into three stations with six PM2.5 and six
  ozone observations each. What is **still not proven from this repository**
  is the whole loop end to end under a real credential, because no credential
  exists here to run it with.

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
