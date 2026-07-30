# Executive Brief Target-Role Validation

Status: PENDING TARGET-ROLE VALIDATION
Date: 2026-07-30

## Purpose and boundary

This record defines the real-person validation required for the Executive Brief
comprehension gate. It does not claim that Gate 1 has passed. Automated tests,
browser checks, agents, and model reviews are engineering evidence only and do
not count toward the six target-role sessions.

## Participant profile

Recruit exactly six real managers or community leaders who did not build the
dashboard. A participant must be able to approach the dashboard as a new
decision-support view rather than as an implementer or coached reviewer.

## Session protocol

Use the same deterministic dashboard and the following script for each
participant:

1. Start from a cold load on the Overview page. Do not coach, explain the
   interface, or identify the brief elements.
2. Give the participant 30 seconds to inspect the dashboard.
3. Ask the participant to identify what is known, what changed, what is
   important, and the next safe action. Record each outcome as a boolean; do
   not correct or prompt the participant during this step.
4. Name either the change or the next safe action the participant identified
   and ask them to open its evidence. Count each activation from the request
   until the evidence is open.
5. End the scored task. Record only the bounded fields below.

The 30-second value is recorded as rounded whole seconds. If the participant
does not identify all four elements within 30 seconds, record `30` and mark the
missing outcomes `false`.

## Pass criteria

A session passes only when all four outcomes are correct without coaching
within 30 seconds and the requested evidence opens within no more than two
interactions.

The aggregate gate passes only if at least five of the six real target-role
sessions pass. A result below five passes, including a narrow miss, remains
failed/pending. No model, agent, or automated result decides the roadmap
consequence.

## Data minimization

Store only:

- anonymous session ID;
- rounded completion seconds;
- four booleans for known, changed, important, and next safe action;
- evidence interaction count;
- session pass/fail; and
- one sanitized, non-sensitive aggregate observation.

Do not store participant names, organizations, contact details, recordings,
screen captures, source data, raw interaction telemetry, sensitive notes, or
free-form personal notes. Observations must describe only non-sensitive,
aggregate interface patterns and must not be attributable to a participant.

## Six-session record

No session has been performed or counted.

| Anonymous session ID | Rounded seconds | Known | Changed | Important | Next safe action | Evidence interactions | Pass/fail |
| -------------------- | --------------- | ----- | ------- | --------- | ---------------- | --------------------- | --------- |
| S01                  | PENDING         | —     | —       | —         | —                | —                     | PENDING   |
| S02                  | PENDING         | —     | —       | —         | —                | —                     | PENDING   |
| S03                  | PENDING         | —     | —       | —         | —                | —                     | PENDING   |
| S04                  | PENDING         | —     | —       | —         | —                | —                     | PENDING   |
| S05                  | PENDING         | —     | —       | —         | —                | —                     | PENDING   |
| S06                  | PENDING         | —     | —       | —         | —                | —                     | PENDING   |

Sanitized aggregate observation: PENDING

Aggregate result: PENDING — 0 of 6 sessions completed; Gate 1 is not claimed.
