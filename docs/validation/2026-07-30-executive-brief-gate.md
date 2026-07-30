# Executive Brief Owner-Accepted Synthetic Validation

Status: ACCEPTED — OWNER-ACCEPTED SYNTHETIC VALIDATION
Date: 2026-07-30

## Purpose and governance boundary

This record closes roadmap Gate 1 through an explicit owner governance decision.
The owner inspected the dashboard, accepted it for the intended decision surface,
and replaced the previously planned six-real-person gate with the bounded
six-agent rehearsal recorded below.

No real-human usability sessions were conducted. The agents are not represented
as humans or human-equivalent research participants. Their outputs do not prove
30-second human comprehension, physical pointer or keyboard behavior, or
real-world usefulness. This is an owner-accepted synthetic product gate, not a
human-subject usability result or a pilot-readiness claim.

The replacement advances internal engineering sequencing to Gate 2. It does not
waive later security gates, real-data authorization, the separate manager-shaped
user criteria in Gate 4, or protected-pilot release verification.

## Rehearsal stimulus and method

- Rehearsal stimulus HEAD: `9a8ef6d2dd53156c46118d8d71154d780b0b9c04`
- Rehearsal stimulus tree: `76c3e0fe825217479b8876dbb63fc61e0e34329b`
- Input: one cold-load `1440×900` screenshot of the deterministic Sacramento
  fixture.
- Isolation: six one-shot multimodal sessions with distinct model IDs, system
  prompts, and manager/community-leader personas. Answers were not shared.
- Blind boundary: agents were instructed not to inspect repository source, tests,
  implementation notes, accessibility trees, or prior dashboard descriptions.
- Evidence targets: three agents received `changed`; three received
  `next-action`.
- Mechanical replay: each selected evidence target was replayed in an isolated
  Playwright context. Every chosen control was unique, visible, and opened the
  requested evidence dialog in one activation.

The hashes above identify the exact dashboard shown during the rehearsal; they
do not claim to identify the later commit that contains this governance record.
The containing commit is identified externally by Git, CI, and exact-head review
because a commit cannot include its own final hash.

The detailed rehearsal summary is
[Six-agent executive-brief rehearsal](2026-07-30-six-agent-executive-brief-rehearsal.md).

## Owner-accepted synthetic criteria

The synthetic gate is accepted because all of the following are true:

- all six structured answers recovered the intended Known, Changed, Important,
  and Next safe action content;
- all six selected the evidence control for the requested target and predicted
  no more than two interactions;
- all six selected paths were mechanically verified to open the requested
  evidence in one automated activation;
- four of six reproduced the displayed statement-type mapping exactly;
- all six supplied a bounded usefulness rating and one bounded need category;
- every visible factual or calculated claim remains evidence-linked, and stale
  or missing data is not presented as fresh; and
- the owner reviewed the dashboard and explicitly accepted this synthetic result
  as the Gate 1 product decision.

These are synthetic acceptance criteria. The words `participant`, `human pass`,
and `30-second human comprehension` must not be used to describe these results.

## Six-agent record

| ID  | Persona                                   | Model                       | Target      | Four-part content | Predicted interactions | Mechanical activations | Strict types | Usefulness | Feedback flags           | Need category              |
| --- | ----------------------------------------- | --------------------------- | ----------- | ----------------- | ---------------------: | ---------------------: | ------------ | ---------: | ------------------------ | -------------------------- |
| A01 | County emergency-management director      | `claude-fable-5`            | changed     | PASS              |                      2 |                      1 | MISS         |          4 | missing-context          | More historical comparison |
| A02 | Regional water-utility operations manager | `claude-opus-5`             | next-action | PASS              |                      2 |                      1 | MISS         |          4 | unclear, missing-context | Clearer alert thresholds   |
| A03 | City manager and executive generalist     | `claude-sonnet-5`           | changed     | PASS              |                      2 |                      1 | PASS         |          4 | missing-context          | Named owner or handoff     |
| A04 | Watershed nonprofit executive director    | `claude-haiku-4-5-20251001` | next-action | PASS              |                      2 |                      1 | PASS         |          4 | missing-context          | Named owner or handoff     |
| A05 | Private-company COO                       | `gpt-5.6-sol`               | changed     | PASS              |                      1 |                      1 | PASS         |          4 | missing-context          | Named owner or handoff     |
| A06 | Elected county supervisor                 | `gpt-5.6-luna`              | next-action | PASS              |                      1 |                      1 | PASS         |          4 | missing-context          | Named owner or handoff     |

## Aggregate result and retained risks

- Synthetic four-part content recovery: **6 of 6**.
- Predicted requested-evidence path within two interactions: **6 of 6**.
- Mechanically valid requested-evidence path in one activation: **6 of 6**.
- Strict displayed statement-type mapping: **4 of 6**.
- Bounded usefulness and need collected: **6 of 6**; usefulness was **4 of
  5** for every agent.
- Repeated need: **4 of 6** selected named owner or handoff.

Retained hypotheses for later real-user observation are action ownership,
historical or threshold context for `+0.3 ft`, the apparent difference between
`1 Gauge Needs Attention` and `3 items need attention`, complete date/local-time
context, and whether users treat the principal provenance labels as exclusive.
No implementation change is inferred solely from model feedback.

## Decision

Aggregate result: ACCEPTED — owner-accepted synthetic Gate 1. No human sessions
were performed or counted, and no claim of human-equivalent validation is made.
Gate 2 engineering may begin subject to its own constraints and approvals.
