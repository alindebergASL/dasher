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

## The OpenAQ capture did not happen, and this note is the reason

The slice called for capturing one bounded real OpenAQ v3 response. **It was
not captured.** `api.openaq.org` answers `401` without an API key, and no
`OPENAQ_API_KEY` is available in this environment.

What that means, precisely:

- The **river** live path is proven against a real payload from the real
  service.
- The **air** live path is proven against the hand-authored fixture's shape
  and against stubbed responses. Its request construction — endpoints, the
  `X-API-Key` header, the bundle assembly — is written from the documented v3
  API and is **unverified against the live service.**

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
