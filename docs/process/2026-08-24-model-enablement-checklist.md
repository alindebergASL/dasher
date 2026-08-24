# What must be true before a model plans a dashboard

Date: 2026-08-24
Occasioned by: PR #49, and the two hours before it

## Why this file exists

Scoping "replace the keyword planner with real generation" ran into three
repository gates and one ADR sequencing rule. Each is sound. None of them is
visible from any of the others:

| Where the constraint lives                                   | What it says                                  |
| ------------------------------------------------------------ | --------------------------------------------- |
| `apps/web/no-model-calls.test.ts`                            | the app must not import the live provider     |
| `packages/planner/package.json`                              | the SDK is a devDependency, not a dependency  |
| `packages/dashboard-schema/src/generated-code-gate.test.ts`  | no dynamic import in first-party source       |
| `docs/architecture/ADR-004-provider-oauth-mcp-boundaries.md` | server-initiated model calls are disabled     |
| `docs/architecture/ADR-005-agentic-dashboard-harness.md`     | a live-provider run comes after five controls |
| `README.md`                                                  | "Model calls: disabled in the product"        |

Discovering that list cost an implementation and a revert. The cost was not the
code; it was that nobody could have priced the work beforehand, because there
was no single place that said what enabling a model requires. This is that
place.

It is a map, not a new rule. Every constraint below already existed.

## The checklist

Status is as of the date above, and every row says how it was checked so a
reader can re-run it rather than trust it. See "Re-checking this file" below.

### Repository gates — these hold today and must keep holding

| #   | Control                                                                                                                        | Status             | Where the answer lives                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | The web app imports neither `@dasher/planner/anthropic` nor `@anthropic-ai/sdk`, and constructs only the deterministic planner | **holds**          | `apps/web/no-model-calls.test.ts`                                                                                                          |
| 2   | `@anthropic-ai/sdk` is a devDependency of `@dasher/planner`, so a production install cannot call a model                       | **holds**          | `packages/planner/package.json`                                                                                                            |
| 3   | No dynamic import anywhere in first-party source                                                                               | **holds**          | `generated-code-gate.test.ts`, `forbiddenPatterns`                                                                                         |
| 4   | Any product planning credential is read only inside a `server-only` module                                                     | **not applicable** | the product reads none; the eval CLI reads `DASHER_EVAL_API_KEY` or `ANTHROPIC_API_KEY`, then passes the value to the provider constructor |

Gate 3 is the one that blocks wiring. Loading the provider lazily — which is
what keeps gate 2 true — is a dynamic import, and the tripwire has no allowance
mechanism by design. **This is a decision, not a bug**: either the rule narrows
to "no dynamic import with a non-literal specifier", or the SDK is promoted and
gate 2 goes, or generation stays out of the app. Nobody should resolve it inside
an implementation slice.

### ADR-005 controls — required before a live provider runs on a deployment

None of these exist as code. That is a statement about today, not a criticism:
the product has no deployment, and ADR-005 scopes these to "the exact
deployment".

| #   | Control          | Status                         | What was found                                                                                                                                                                                                              |
| --- | ---------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5   | Gateway          | **absent**                     | The relevant implementation match is a seam: `anthropic.ts` accepts a `baseURL` "for pointing the eval at a gateway or a recording proxy". Nothing routes product calls through one.                                        |
| 6   | Secret redaction | **absent**                     | Zero matches for `redact` in first-party source. `packages/control-plane/src/secrets.ts` is HMAC and token handling, not log redaction — a different thing with a similar name.                                             |
| 7   | Spend budget     | **absent**                     | Matches for "budget" refer to revision, complexity, or byte limits and to gate prose. No provider-spend accounting or enforcement exists.                                                                                   |
| 8   | Revocation       | **absent for provider access** | The control plane revokes _session tokens_ (`request-context.ts`, and an integration test for a revoked session). That is tenant auth, not provider access, and reusing the word for both is how a checklist ends up lying. |
| 9   | Kill switch      | **absent**                     | Matches only inside `gate-contracts.test.ts`, which asserts the _text_ of gate documents. No switch.                                                                                                                        |

### What is already true and worth not re-deriving

- The provider envelope already implements structured output derived from
  `DashboardPlanSchema`, refinement and revision handling, and a credential
  constructor argument. The eval CLI, not the provider class, reads that
  credential from its environment.
- Provider output is untrusted end to end. `runPlanner` parses it, checks its
  selections against observations that exist, compiles numeric values with
  trusted code, and validates the result. Those boundaries protect structure and
  computed values. Planner-written free text still reaches the reader verbatim:
  the bounded detector catches its enumerated measurement and directive shapes,
  not general semantic claims.
- The free-text gate covers measurements and directives in the five fields that
  reach a reader verbatim, for both sensor domains as of PR #49.
- `eval/adversarial.ts` already contacts a real model, with an explicit key and
  model, and exits non-zero without them. **A live call is therefore not a new
  capability** — it is a capability that exists outside the product and has
  never existed inside it.

## The distinction this file exists to make

ADR-005 gates a live provider **on a deployment**. Everything in rows 5–9 is
about running a model where a customer's request reaches it and a bill accrues.

That is not the same question as whether a developer can run one locally to find
out what the envelope does under real output. The second is answerable today.
The recorded 2026-08-15 sweep exercised 135 river-domain generations through
`AnthropicPlanningProvider`; it produced both free-text and duplicate-section
findings and supplied regression strings that remain in `freetext.test.ts`.
What has not been rerun live is the current combination: domain-parameterised
prompts including air, the pattern registry, packing v1, and the detector after
PR #49. That combined run is worth more than another unmeasured envelope slice.

Conflating the two questions is what makes "wire up generation" look like it
needs five unbuilt controls. It needs one decision (gate 3) to be answerable in
development.

## Re-checking this file

The absence claims are the ones that rot. Each was produced by a command:

```sh
# Rows 5-9 are separate discovery probes. Read every match: neither an empty
# result nor a non-empty one proves whether the named control is implemented.
grep -rniE "model.?gateway|provider.?gateway|baseURL" \
  --include='*.ts' packages apps | grep -v node_modules || true
grep -rniE "redact|secret.?(mask|scrub)" \
  --include='*.ts' packages apps | grep -v node_modules || true
grep -rniE "spend|cost|token.?budget|budget" \
  --include='*.ts' packages apps | grep -v node_modules || true
grep -rniE "provider.?revoc|revoke.*provider|revocation" \
  --include='*.ts' packages apps | grep -v node_modules || true
grep -rniE "kill.?switch|disable.*provider|provider.*disable" \
  --include='*.ts' packages apps | grep -v node_modules || true

# Row 2. Must print False for dependencies and True for devDependencies.
python3 -c "import json;d=json.load(open('packages/planner/package.json'));\
print('@anthropic-ai/sdk' in d.get('dependencies',{}), \
'@anthropic-ai/sdk' in d.get('devDependencies',{}))"
```

Read the matches before believing them. Writing this file the first time, a
narrow grep that skipped test files reported zero matches for all five controls;
a wider one reported 36, of which every single one turned out to be gate-document
prose, session-token revocation, or a comment. Both greps were "evidence"; only
the second one was checked.

## What this file does not do

It does not decide gate 3, does not argue for or against enabling a model, and
does not claim the five ADR-005 controls are unnecessary. It records what is
true so that whoever decides is deciding rather than discovering.
