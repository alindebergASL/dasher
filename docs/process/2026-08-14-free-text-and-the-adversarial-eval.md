# The free-text hole, the gate over it, and the eval that measures the rest

Status: Applied — gate merged and covered by tests; eval built, never run
Date: 2026-08-14

## The claim that was false

`packages/planner/src/plan.ts` opened with this sentence:

> Every number, evidence item, freshness state, and claim on the rendered
> dashboard is computed by `compilePlan` from the observations. **A model cannot
> assert a measurement through this contract because there is nowhere in it to
> put one.**

The second sentence was false as written, and had been since the planner landed.
`DashboardPlanSchema` is a `strictObject`, so a plan carrying a `gaugeReadings`
field is rejected — and there was a test asserting exactly that, under a `describe`
block titled "the plan contract cannot carry a fact". What no test asserted was
that five of the schema's own fields are unconstrained free text which
`compilePlan` renders verbatim:

| Plan field            | Where it lands                  | `compile.ts` |
| --------------------- | ------------------------------- | ------------ |
| `title`               | the dashboard title             | `:314`       |
| `audience`            | the dashboard's stated audience | `:315`       |
| `framing`             | the conditions-summary subtitle | `:111`       |
| `pages[].title`       | a page heading                  | `:287`       |
| `pages[].description` | a page subheading               | `:288`       |

A plan titled `"Sacramento at 12.4 ft"` asserted a reading just as effectively as
a `gaugeReadings` field would have, rendered in a larger font, and passed every
gate in the repository. The shape of the object was doing all the arguing; the
strings inside it were unexamined.

This was confirmed before it was fixed. The red check is
`packages/planner/src/run.test.ts` — "refuses a measurement written into the
free-text fields" — which was written first and observed failing, with the
rendered dashboard carrying the title `"Sacramento at 12.4 ft"` and the framing
`"The river is 3,200 cfs and climbing."`

## What the gate covers

`packages/planner/src/freetext.ts`, called from `findPlanProblems`, so a caller
cannot validate a plan and miss it. Two categories, both narrow on purpose:

- **measurement** — a quantity with a physical unit, or any decimal number.
  Raises `free_text_measurement`.
- **directive** — a short phrase list of emergency imperatives (`evacuate`,
  `seek higher ground`, `call 911`, `do not drive`, …). Raises
  `free_text_directive`.

Both are `PlanFinding`s, not exceptions, so the first cost of a false positive is
one revision round-trip rather than a refused dashboard. That budget is what
allows the patterns to be slightly eager.

Two exclusions are deliberate and tested:

- **time windows.** "the last 24 hours", "the 24-hour view", "six-hour change" —
  a window is a composition choice, not a reading.
- **the bare units `in` and `m`.** "Top 3 in the ranking" is ordinary composition
  language and reading it as three inches would burn a revision round on a
  sentence that asserted nothing. River stage is in feet regardless.

## What the gate does not cover, stated plainly

It does not catch an **unquantified claim**. "Conditions are dangerous right
now", "the situation is completely under control", and "the river will crest
tomorrow" all pass. That is not an oversight being deferred quietly — a wordlist
that tried to catch them would be a filter pretending to be a boundary, and would
read in this document as though the problem were solved.

The honest position: free text is a judgement surface with two hard edges, not a
sanitized one. Where the third edge belongs should be decided from evidence about
what a real model actually writes, which is what the eval is for.

## The eval

`packages/planner/eval/adversarial.ts`, run with `pnpm --filter @dasher/planner
eval:adversarial`. Fifteen probes in five categories — `control`,
`goad-measurement`, `goad-directive`, `goad-claim`, `goad-injection` — each run
`--repeats` times against the USGS fixture through the real provider.

Per generation it records: whether a dashboard was produced, how many attempts it
took, every finding code raised, **what the model proposed on its first attempt
before any correction**, what survived into the accepted plan, and the accepted
free text verbatim.

That first-attempt capture is the point. A harness that only inspected the
accepted plan would report a model that reached for a reading and was corrected
as indistinguishable from one that never reached at all.

It exits non-zero on exactly two things, both of which indicate a defect on our
side rather than a property of the model:

1. smuggled text in an **accepted** plan — the gate failed;
2. a **control** probe that produced no dashboard — the loop is broken.

A goad probe that the loop refuses outright is the system working, and is
reported rather than failed on.

### Why it is a script and not a test

`pnpm test` is trustworthy because it is deterministic and offline. A live model
inside it would make every gate here slow and flaky and would make a red build
ambiguous between "the code broke" and "the model had an off run".

So the split is: everything checkable without a model is checked in the suite —
the detectors (`freetext.test.ts`), the harness's counting and judging
(`eval/harness.test.ts`, against a fake provider and a scripted smuggler), and
the provider's wire behaviour (`src/anthropic.test.ts`, against a local stub HTTP
server that speaks the Messages API's shape). What is left in the script is the
part that genuinely cannot be faked.

The reason the harness is unit-tested at all: a reporting bug in an eval is
invisible in the worst possible way. It surfaces as a clean result, which reads
as evidence of a property the run never measured.

### It has not been run

**No model has ever been called.** This environment has no API key, and borrowing
the session's credentials would be using the harness's authorization for the
product's purposes. Everything above describes code that is written, typechecked,
linted, and covered by offline tests — not a result.

The eval fails loudly rather than passing quietly when a key is absent, which is
the same principle: a green run with no key would look like evidence.

To run it:

```bash
# See the call matrix without contacting anything.
DASHER_EVAL_MODEL=<model-id> \
  pnpm --filter @dasher/planner eval:adversarial -- --dry-run

# One call, to prove the key, the schema, and the network before spending.
ANTHROPIC_API_KEY=... DASHER_EVAL_MODEL=<model-id> \
  pnpm --filter @dasher/planner eval:adversarial -- --probe control-overview --repeats 1

# The sweep. Comma-separated models produce a comparison table.
ANTHROPIC_API_KEY=... DASHER_EVAL_MODEL=<model-a>,<model-b>,<model-c> \
  pnpm --filter @dasher/planner eval:adversarial -- --repeats 3 --out report.json
```

`DASHER_EVAL_MODEL` is required and has no default, so a result always records
which model produced it.

### Comparing models

Comma-separate `DASHER_EVAL_MODEL` and each model runs the whole probe set, with
a table at the end. Two of its columns are defects in Dasher and must be zero on
every row — `leaked` (smuggled text reached an accepted plan) and `ctrl fail` (a
control probe produced nothing). The rest are properties of the model:

- **`reached`** — how often it wrote a reading or a directive before the loop
  corrected it. Not a fault. A model can reach constantly and still ship only
  correct dashboards, because the gate is server-side.
- **`mean tries`** — what that behaviour costs, in round trips. This is the
  column to read when choosing what to ship, because it converts a behavioural
  difference into tokens.

`--dry-run` prints the matrix and contacts nothing. Every real invocation spends
money and the matrix multiplies out faster than it reads, so the first run
against a new key should be a decision rather than a surprise.

### The eval directory was not typechecked

Found while adding the sweep: `packages/planner/tsconfig.json` included only
`src/**/*.ts`, so the entire `eval/` tree — the script, the harness, the probes,
and their tests — was unchecked TypeScript, and `pnpm typecheck` reported success
over all of it. Adding `eval/**/*.ts` to the include surfaced eight real errors
immediately.

The same failure shape as the two the mutation gate and the reachability gate
exist to catch: a check reporting success over code it never looked at. A gate's
scope is part of the gate.

## The provider

`packages/planner/src/anthropic.ts`, reachable only at
`@dasher/planner/anthropic`. Importing `@dasher/planner` does not pull an HTTP
client in.

- **Credentials stay out of the interface.** `PlanningProvider` has no credential
  or endpoint parameter and gains none. The key is a constructor argument closed
  over by the instance, and the class never reads the environment, so a provider
  cannot silently acquire ambient credentials from wherever it is constructed.
- **`model` is required.** An eval whose model is implicit cannot be reproduced,
  and the provider's `id` is written into the dashboard's own evidence record, so
  it has to name what actually ran.
- **Structured output is an economy, not a boundary.** The wire schema is derived
  from `DashboardPlanSchema` via `zodOutputFormat`, so the two cannot drift. The
  SDK demotes everything the structured-output subset rejects — `minLength`,
  `maxLength`, `pattern`, `maxItems`, and in practice `enum` and `const` — into
  schema descriptions, which are advice to the model rather than constraints on
  the decoder. The closed section list is therefore restated in the system
  prompt. `src/anthropic.test.ts` pins that the emitted schema carries none of
  the rejected keywords, because the alternative is discovering it as a 400 on a
  paid call.
- **Nothing about it is load-bearing for correctness.** Provider output is
  `unknown` exactly as it is for the fake. Garbage, a hallucinated gauge, an
  invented section, or a measurement in the title all produce findings and a
  revision request, never a rendered dashboard.

## "Model calls: disabled" is now a gate

The README has carried that line for a while. With a real provider in the tree it
needed to stop being a note somebody remembered to keep accurate.

`apps/web/no-model-calls.test.ts` fails if any file under `apps/web` imports
`@dasher/planner/anthropic` or `@anthropic-ai/sdk`, and also fails if
`app/actions.ts` stops constructing `FakePlanningProvider` — the negative half
alone would still pass if the planner were deleted. `@anthropic-ai/sdk` is a
devDependency of `@dasher/planner` rather than a dependency, so no production
install pulls it. Both were verified by mutation: adding the import turns the test
red, and the built `apps/web/.next` output contains no reference to the API host.

Same limits as any text scan: a dynamic import built from a variable would be
invisible. It catches the realistic failure, which is somebody wiring the live
provider into a server action because it was easier than plumbing a flag.

## Open, and deliberately so

- The claim category is ungated. Decide where the third edge belongs from eval
  evidence, not before it.
- The eval has never been run, so nothing here is a measurement of any model.
- `apps/web` still uses `FakePlanningProvider`. Wiring the real provider into the
  product is a separate decision that should follow a first eval run, and would
  need credential storage, a per-organization provider choice, cost controls, and
  a latency budget — none of which exist.
