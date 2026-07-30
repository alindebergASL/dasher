# Executive Brief Target-Role Validation

Status: PENDING TARGET-ROLE VALIDATION
Date: 2026-07-30

## Purpose and boundary

This record defines the real-person validation required for the complete roadmap
Gate 1. It does not claim that Gate 1 has passed. Automated tests, browser
checks, agents, and model reviews are engineering evidence only and do not count
toward the six target-role sessions.

The fixture-only interface keeps evidence-open counts, next-action review,
usefulness, and bounded feedback in React tab memory. It does not persist,
transmit, log, or export those events. Reloading the page erases them. A
facilitator may transcribe only the bounded, anonymous fields below after the
participant completes the session.

## Participant profile

Recruit exactly six real managers or community leaders who did not build the
dashboard. A participant must approach the dashboard as a new decision-support
view rather than as an implementer or coached reviewer.

## Session protocol

Use the same deterministic dashboard and the following script for each
participant:

1. Start from a cold load on the Overview page. Do not coach, explain the
   interface, or identify the brief elements.
2. Give the participant 30 seconds to inspect the dashboard.
3. Ask the participant to identify what is known, what changed, what is
   important, and the next safe action. Record each outcome as a boolean; do
   not correct or prompt during this step.
4. Before naming the evidence task, the facilitator opens **Session feedback · not saved**, selects the bounded requested target (`Changed` or `Next safe action`), activates **Start evidence task**, and closes the dialog. Then name that same target and ask the participant to open its evidence. Record the task counter after the requested target's evidence opens. The counter includes every click, tap, keyboard Enter/Space activation, and Escape after the dialog closes; opening unrelated evidence does not stop it. Tab-only focus movement is not an activation.
5. Ask the participant to review the recommended next action. Record the
   in-memory next-action-reviewed boolean.
6. Ask the participant which labels denote observed source facts,
   deterministic calculations, interpretations, and recommendations. Record
   one statement-types-distinguished boolean; do not retain their words.
7. Ask for a 1–5 usefulness rating using the bounded controls.
8. Ask whether anything was wrong, unclear, or missing context. Record only
   the selected bounded flags; record `none` if no flag is selected.
9. Require one missing-information or workflow-need choice from the bounded
   list: more historical comparison, clearer alert thresholds, named owner or
   handoff, more local impact context, export or sharing workflow, or other
   sanitized aggregate need. Do not collect free text.
10. End the session and transcribe only the bounded record below. Reload the
    page to erase in-memory telemetry before the next participant.

The 30-second value is recorded as rounded whole seconds. If the participant
does not identify all four elements within 30 seconds, record `30` and mark the
missing outcomes `false`.

## Pass criteria

The comprehension outcome passes when all four decision outcomes are correct
without coaching within 30 seconds.

Independently, the evidence outcome passes when the requested target's evidence
opens within no more than two counted interactions.

The complete Gate 1 aggregate passes only when all of the following are true:

- at least five of six comprehension outcomes pass;
- independently, at least five of six evidence outcomes pass;
- at least four of six distinguish observed source facts, deterministic
  calculations, interpretations, and recommendations; and
- all six supply a bounded usefulness rating and one bounded missing-information
  or workflow-need category.

A result below any threshold, including a narrow miss, remains failed/pending.
No model, agent, or automated result decides the roadmap consequence.

## Data minimization

Store only:

- anonymous session ID;
- rounded completion seconds;
- four booleans for known, changed, important, and next safe action;
- requested evidence target: `changed` or `next-action`;
- evidence interaction count;
- next-action-reviewed boolean;
- statement-types-distinguished boolean;
- usefulness rating from 1 through 5;
- bounded feedback flags: `wrong`, `unclear`, `missing-context`, or `none`;
- one bounded missing-information/workflow-need category;
- separate comprehension-pass and evidence-pass booleans; and
- sanitized, non-sensitive aggregate observations.

Do not store participant names, organizations, contact details, recordings,
screen captures, source data, raw interaction telemetry, event timestamps,
free-form participant comments, or sensitive notes. Aggregate observations must
describe only non-sensitive interface patterns and must not be attributable to
a participant.

## Six-session record

No session has been performed or counted.

| ID  | Seconds | Known | Changed | Important | Next | Evidence target | Evidence interactions | Next reviewed | Types distinguished | Usefulness 1–5 | Feedback flags | Need category | Comprehension pass | Evidence pass |
| --- | ------: | ----- | ------- | --------- | ---- | --------------- | --------------------: | ------------- | ------------------- | -------------: | -------------- | ------------- | ------------------ | ------------- |
| S01 | PENDING | —     | —       | —         | —    | —               |                     — | —             | —                   |              — | —              | —             | PENDING            | PENDING       |
| S02 | PENDING | —     | —       | —         | —    | —               |                     — | —             | —                   |              — | —              | —             | PENDING            | PENDING       |
| S03 | PENDING | —     | —       | —         | —    | —               |                     — | —             | —                   |              — | —              | —             | PENDING            | PENDING       |
| S04 | PENDING | —     | —       | —         | —    | —               |                     — | —             | —                   |              — | —              | —             | PENDING            | PENDING       |
| S05 | PENDING | —     | —       | —         | —    | —               |                     — | —             | —                   |              — | —              | —             | PENDING            | PENDING       |
| S06 | PENDING | —     | —       | —         | —    | —               |                     — | —             | —                   |              — | —              | —             | PENDING            | PENDING       |

Sanitized aggregate interface observation: PENDING

Sanitized aggregate need summary: PENDING

Aggregate result: PENDING — 0 of 6 sessions completed; Gate 1 is not claimed.
