# Six-Agent Executive-Brief Rehearsal

Status: ACCEPTED AS SYNTHETIC GATE EVIDENCE
Date: 2026-07-30

This is a synthetic model rehearsal, not human research. It contains no human
sessions, establishes no valid 30-second human timing, and must not be described
as human-equivalent validation.

## Candidate and protocol

The rehearsal evaluated dashboard HEAD
`9a8ef6d2dd53156c46118d8d71154d780b0b9c04`, tree
`76c3e0fe825217479b8876dbb63fc61e0e34329b`. Six isolated one-shot multimodal
model sessions saw the same cold-load `1440×900` screenshot. Each received a
distinct system prompt and target-role persona; no answers were shared. Three
were asked to locate Changed evidence and three Next safe action evidence.

Agents were prohibited from inspecting source, tests, implementation notes,
accessibility trees, or prior dashboard descriptions. Their selected paths were
then replayed mechanically in fresh Playwright contexts. The browser replay
proved only target visibility and dialog mechanics, not usability.

## Independent sessions

| ID  | Persona                                   | Model                       | Target      | Four-part content | Predicted interactions | Mechanical activations | Strict types | Usefulness | Feedback flags           | Need category              |
| --- | ----------------------------------------- | --------------------------- | ----------- | ----------------- | ---------------------: | ---------------------: | ------------ | ---------: | ------------------------ | -------------------------- |
| A01 | County emergency-management director      | `claude-fable-5`            | changed     | PASS              |                      2 |                      1 | MISS         |          4 | missing-context          | More historical comparison |
| A02 | Regional water-utility operations manager | `claude-opus-5`             | next-action | PASS              |                      2 |                      1 | MISS         |          4 | unclear, missing-context | Clearer alert thresholds   |
| A03 | City manager and executive generalist     | `claude-sonnet-5`           | changed     | PASS              |                      2 |                      1 | PASS         |          4 | missing-context          | Named owner or handoff     |
| A04 | Watershed nonprofit executive director    | `claude-haiku-4-5-20251001` | next-action | PASS              |                      2 |                      1 | PASS         |          4 | missing-context          | Named owner or handoff     |
| A05 | Private-company COO                       | `gpt-5.6-sol`               | changed     | PASS              |                      1 |                      1 | PASS         |          4 | missing-context          | Named owner or handoff     |
| A06 | Elected county supervisor                 | `gpt-5.6-luna`              | next-action | PASS              |                      1 |                      1 | PASS         |          4 | missing-context          | Named owner or handoff     |

The six model IDs are distinct. Provider diversity is not six-way: four are
Claude-family models and two are OpenAI models run through Codex.

## Aggregate rehearsal result

The owner-approved synthetic thresholds are 5/6 for four-part content, 5/6 for
predicted evidence reachability, no pass threshold for mechanical replay, 4/6
for strict displayed types, and 6/6 for bounded usefulness and need.

| Synthetic measure                               | Result | Rehearsal threshold |
| ----------------------------------------------- | -----: | ------------------: |
| Four-part content recovered                     |    6/6 |                 5/6 |
| Predicted evidence path within two interactions |    6/6 |                 5/6 |
| Chosen evidence path mechanically opened        |    6/6 |                 n/a |
| Strict displayed statement-type mapping         |    4/6 |                 4/6 |
| Bounded usefulness and need supplied            |    6/6 |                 6/6 |

Each mechanically replayed target was unique, visible, and opened its requested
evidence dialog in one automated activation. Every model rated the dashboard
4/5 useful.

## Product hypotheses

1. **4 of 6** selected `Named owner or handoff`; action ownership is the most
   repeated missing context.
2. The emergency-management persona wanted historical or flood-stage context
   for `+0.3 ft`; the operations persona wanted clearer alert thresholds.
3. The operations persona read `1 Gauge Needs Attention` and `3 items need
attention` as inconsistent, although one gauge can produce several
   conditions.
4. Four models reproduced the displayed provenance labels exactly. Two added
   plausible secondary semantic types beyond the displayed principal type.
5. The operations persona wanted a complete date/local-time equivalent and a
   visible staleness threshold.

These are hypotheses for later real-user observation, not automatic change
requests. Changing the dashboard solely to optimize model responses would risk
overfitting the reference implementation.

## Owner decision

The owner inspected the dashboard, accepted its quality, and explicitly replaced
the previously planned real-person Gate 1 with this owner-accepted synthetic
product gate. No agent was entered as a human participant, and no human usability
claim is made.
