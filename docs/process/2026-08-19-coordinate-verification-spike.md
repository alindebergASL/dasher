# The coordinate-verification spike, and what it accepts

Date: 2026-08-19

## Learning question

ADR-008 says an extracted value must verify at recorded coordinates in a
retained, hash-checked snapshot, and says plainly that this proves lexical
grounding rather than semantic mapping. It also says the first spike must
measure **false acceptances**, not only rejections, because a spike reporting
only its rejection rate measures the easy half.

**Does coordinate verification work — what does it reject, and what does it
wrongly accept?**

**Answer: it rejects everything it was designed to reject, and it catches none
of the seven semantic-error classes. Zero of seven.** That is the expected
result, and having it as a measurement rather than a prediction is what changes
the decision.

Offline. No product integration, no live search, no routing, no UI, no MCP.
`@dasher/extraction-spike` is reachable from nothing.

## The corpus is real documents

Both captures were already in the repository and are already used by the
product. Nothing was authored for the spike, because a corpus written to make a
verifier look good measures the author.

| Document                                       | What                                                                                                                                                                                                |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fixtures/ucr/campus-facts-2025.html`          | UC Riverside Institutional Research Campus Facts, 64,809 bytes, with a real provenance sidecar (source URL, retrieval time, sha256) that the loader reproduces                                      |
| `fixtures/openaq/live-capture-2026-08-18.json` | The OpenAQ v3 capture taken during the live-source slice, 62,621 bytes, no sidecar — so the spike seals the bytes and records the hash it computed rather than claiming a provenance it cannot show |

Ground truth comes from the captures' own snapshot sidecar: Fall 2025
undergraduate 24,034, graduate 3,599, total 27,633; Fall 2024 22,599 / 3,785 /
26,384.

Every coordinate in the corpus was computed from the actual bytes. Coordinates
are **byte** offsets, not string indices: the hash is over bytes, so the
coordinates that hash protects have to be over bytes too. A character offset
into a JavaScript string is a UTF-16 code-unit offset, which is a third
coordinate system agreeing with neither.

## What it rejects

All nine refusal reasons are deterministic and fail-closed. Seven are reached by
the corpus; two (`unknown-snapshot`, `unit-not-in-extracted-text`) cannot be
reached from real documents and are covered by unit tests instead — a test
asserts that no reason is left unexercised by both.

The two worth quoting, because they are the ones the ADR singled out:

```
refusal/correct-text-elsewhere-wrong-locator     REFUSED(coordinate-text-mismatch)
    bytes [18174, 18180) hold "24,034", candidate claims "27,633"
```

`27,633` genuinely occurs in this document, twice. Claiming it at coordinates
that hold something else is refused. That is the difference between checking a
citation and checking a search hit.

```
refusal/source-bytes-changed                     REFUSED(hash-mismatch)
    document hashes a21d2dbb…, candidate claims 06556cdc…
```

One byte changed in the page after retrieval. Under immutable-store semantics
that is corruption rather than staleness, and it fails closed on every claim
resting on the snapshot.

## What it accepts, and should not

Seven probes. Each quotes real characters at real coordinates, hashes correctly,
and normalises to its stated value. **All seven were accepted.** The verifier
has no basis to refuse any of them.

| Class            | The candidate        | Why it is wrong                                                                     |
| ---------------- | -------------------- | ----------------------------------------------------------------------------------- |
| subject          | 27,633 at byte 18018 | attributed to UCLA; nothing in the characters names a campus                        |
| field            | 24,034 at byte 18174 | bound to `total-enrollment`; 24,034 is undergraduates                               |
| reporting period | 26,384 at byte 22896 | bound to Fall 2025; it is the Fall 2024 cell of the same row                        |
| unit             | 3,599 at byte 18239  | bound to `graduate-share-of-total`; that share is 13.0%, not 3,599                  |
| denominator      | 13.0% at byte 18264  | share of the total presented as a share of undergraduates, which would be 15.0%     |
| section          | 4.7% at byte 30592   | San Diego County's share of undergraduates, lifted into the enrollment-growth claim |
| fragment         | 4.7% at byte 38905   | a span that cuts `84.7%` down to `4.7%`                                             |

Two of these deserve emphasis because they were not hypothetical constructions.

**The section collision is real.** `4.7%` occurs three times in this document.
One is the one-year enrollment growth. Another, 12kB away, is San Diego
County's share of undergraduate origin. Identical characters, unrelated facts,
both verifiable.

**The fragment class is not in ADR-008's list, and the corpus found it.** Byte
38905 sits inside `84.7%`. A span of `[38905, 38909)` yields `4.7%` — genuinely
those characters, genuinely at those coordinates, normalising correctly to 4.7
percent. It is still a fragment of a different number. Coordinate verification
checks what is _inside_ a span and never what abuts it, so a locator that starts
mid-token is invisible to it. This is cheap to fix and worth fixing: requiring
that the bytes either side of a numeric span are not themselves digits or
separators would refuse it deterministically. That is a candidate for
normalisation version 2 rather than a change to be smuggled into version 1.

## The number, and what it is not

```
Semantic-error classes probed: 7. Caught by coordinate verification: 0.
```

The report also prints that 7 of 11 accepted candidates are factually wrong,
which is 63.6%. **That percentage is not a base rate and must not be quoted as
one.** It is a property of how the corpus was composed — it probes seven error
classes deliberately — so it moves whenever a case is added. A test asserts the
report says so, because a convenient number left lying around gets quoted.

What the spike establishes is _which_ classes are invisible to a lexical check.
It says nothing about how often a model commits them. Measuring frequency needs
model-produced candidates over a labelled document set, which this slice does
not attempt and which is the obvious next question.

## The strictness cost is one case, and it points somewhere

Six candidates were refused despite being factually true. Split by cause,
because these mean opposite things:

| Family      | Count | Reading                                                |
| ----------- | ----- | ------------------------------------------------------ |
| provenance  | 2     | fail-closed working: wrong hash, changed bytes         |
| coordinates | 2     | fail-closed working: off-by-one, right text elsewhere  |
| contract    | 1     | fail-closed working: unsupported normalisation version |
| lexis       | 1     | the only real cost                                     |

The single lexical cost is `27,633 students` — a span that ran one word past the
number, refused because `students` is not a unit spelling. That is a useful
signal: ADR-008 deferred "exact-substring or normalised" as the first question
the spike should answer, and the answer this corpus gives is that **separators
were never the pressing problem — span boundaries are.** Thousands separators,
percentages, and both micro-sign spellings all worked first time. The failure
was a span that included too much, and the fragment class above is a span that
included too little. Both are boundary problems, and neither is fixed by
loosening what characters a number may contain.

## What the corpus does not exercise, stated rather than implied

- **Whitespace and dash normalisation.** Neither capture contains one of these
  characters inside a numeric token. The UCR document's eight `&nbsp;` entities
  are all layout — table headers and spacer list items — and none is adjacent to
  a number. Supported and unit-tested; claimed by no corpus candidate.
- **The `ug_per_m3` unit identity.** The OpenAQ capture never places a number
  and its unit in one contiguous span (`"value": 16.0` and `"units": "µg/m³"`
  are different JSON members), so no real candidate can quote both at once.
  Unit-tested only.

## What this does not change

No product code, no schema, no routing, no UI. ADR-008 remains Proposed and this
spike does not promote it. `classifyRequest` still refuses unsupported and
ambiguous requests exactly as before.

## What it means for the tier

ADR-008 says extraction is "coordinate-verified and semantically unverified."
This slice turns that from a claim into a measurement: the semantic half is
unverified in the strongest sense, in that a lexical checker catches none of it,
including on a document where two unrelated facts share the same characters.

The decision the ADR reserved — whether `extracted` may reach decision-bearing
surfaces or feed calculations — is not answered here, because answering it needs
the frequency measurement above, not this one. What this slice does establish is
that no _deterministic lexical_ boundary will control the semantic classes. If a
control exists it will be a different mechanism: an independent second
extraction, a structural cross-check against the label abutting the value, or a
human acceptance step. Only the fragment class is deterministically fixable, and
fixing it does not touch the other six.

## Running it

```
pnpm --filter @dasher/extraction-spike report   # the acceptance/rejection report
pnpm --filter @dasher/extraction-spike test     # 59 tests
```
