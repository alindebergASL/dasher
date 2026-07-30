# Foundation Security Status

Date: 2026-07-30

## Posture summary

- Dasher remains fixture-only. There are no live USGS, model, or generated-code
  execution paths.
- `docs/security/GENERATED_CODE_GATE.md` remains `Status: CLOSED`. The source
  scan is an explicitly limited static regression tripwire, not proof of
  generated-code isolation. The gate document remains authoritative.
- `SafeSourceUrlSchema` accepts only credential-free HTTP(S) URLs. These URLs
  are display provenance only; they never authorize fetching and must not be
  reused as a fetch-target security policy.
- All declared DashboardSpec and USGS strings and nested arrays are bounded.
  Pre-Zod serialized-size ceilings and cumulative item, point, evidence
  reference, and USGS observation budgets limit multiplicative schema shapes.
- Dashboard evidence and freshness timestamps must be internally ordered, and
  `fresh` requires a latest observation timestamp. The schema cannot derive a
  universal freshness-age threshold: status derivation remains trusted
  domain/planner policy.
- Generated-code enablement still requires every invariant and adversarial
  check in the gate document; this work does not relax that decision.

## Input-boundary controls

`DashboardSpec` is capped at 1 MiB of serialized UTF-8 before Zod validation.
Its global budgets cap 2,000 total items, 10,000 trend points, and 10,000
evidence references, while each `evidenceIds` array is capped at 32. The USGS
payload is capped at 5 MiB before Zod and at 20,000 observations across all
series and value groups. These limits are exported constants, and the checked-in
fixture and current deterministic planner output remain unchanged.

Strict unknown-field rejection remains in place throughout DashboardSpec.
The USGS schema intentionally retains Zod's object-stripping behavior for
compatibility with additional upstream response fields.

Installed Zod 4.4.3 `z.number()` rejects `Infinity`, `-Infinity`, and `NaN` by
default. Adding `.finite()` would be redundant for this installed version, so
the schemas retain `z.number()` and record the verified version-specific
rationale here.

## Supply chain

`pnpm-lock.yaml` uses lockfile version 9.0 and CI installs it with
`pnpm install --frozen-lockfile`. `pnpm-workspace.yaml` pins `postcss` to 8.5.25
and `sharp` to 0.35.3 through `overrides`. `onlyBuiltDependencies: [sharp]`
permits lifecycle scripts only for `sharp`.

The CI workflow pins its reviewed actions to immutable SHAs, with version
comments: checkout v4, pnpm/action-setup v4, setup-node v4, and upload-artifact
v4. CI retains least-privilege `contents: read`, blocking high-severity audits,
the exact CLOSED-line check, clean-tree verification, and failure-only artifact
upload.

Both dependency audits passed in the controller's complete post-remediation Task 7 run:

| Audit                   | Exact command                          | Result                    |
| ----------------------- | -------------------------------------- | ------------------------- |
| Full dependency graph   | `pnpm audit --audit-level high`        | PASS — no vulnerabilities |
| Production dependencies | `pnpm audit --prod --audit-level high` | PASS — no vulnerabilities |

CI fails for vulnerabilities of severity high or critical. Any ignored advisory
requires a CVE-specific entry under `pnpm-workspace.yaml` `auditConfig` and a
rationale row in this document.

Audit exceptions: none.

## Qwen 3.8 review findings — reconciled dispositions

Source: `/tmp/dasher-qwen38-agent-review.txt`. The report has no blocker or
important finding and exactly three minor findings.

| ID     | Finding                                                                                                                | Severity    | Disposition            | Evidence                                                                                                                                                                                                                                      |
| ------ | ---------------------------------------------------------------------------------------------------------------------- | ----------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q38-01 | The report claimed `z.number()` accepts `Infinity` and `-Infinity`, allowing non-finite gauge and trend values.        | Minor (Low) | `not-applicable`       | Installed Zod 4.4.3 rejects `Infinity`, `-Infinity`, and `NaN` through `z.number()`; `.finite()` is redundant for this installed version.                                                                                                     |
| Q38-02 | Summary claims and metric cards used content-derived React keys, allowing collisions when text or labels repeat.       | Minor (Low) | `fixed-in-this-branch` | DashboardSpec validation requires claim-text and metric-label uniqueness within each component, and the renderer uses component-scoped positional keys. Tests cover schema rejection and clean rendering.                                     |
| Q38-03 | DashboardSpec and USGS collections lacked upper bounds, creating future resource-consumption and renderer spread risk. | Minor (Low) | `fixed-in-this-branch` | All declared strings and arrays are bounded; pre-Zod byte ceilings and cumulative DashboardSpec item/point/evidence-reference and USGS observation budgets prevent multiplicative maxima. Renderer spread inputs remain individually bounded. |

## Qwen production and pilot gaps (G-1 through G-8)

These are durable future gates from the Qwen transcript. They are not claims
that the fixture-only foundation is production-ready.

- **G-1 — Content Security Policy:** No deployment CSP is configured. A reviewed
  CSP remains required before deployment.
- **G-2 — Resource bounds:** The reported unbounded-array gap is remediated:
  every declared nested array and string has a limit, with serialized and global
  complexity budgets. Limits must still be reviewed against any future live
  product workload.
- **G-3 — Authentication and tenant isolation:** Authentication, authorization,
  organization scoping, and tenant isolation do not exist and remain production
  gates.
- **G-4 — Rate and edge request controls:** Schema byte limits are defense in
  depth, not rate limiting. Edge request-size enforcement, parsing timeouts,
  cancellation, and rate limits remain required before network input.
- **G-5 — Audit logging:** Tamper-evident logs for generation, validation,
  evidence retrieval, publication, and user actions remain required.
- **G-6 — SSRF and connector controls:** Display provenance URL validation is
  not fetch authorization. Any live fetcher requires destination allowlists,
  DNS-rebinding defenses, redirect policy, timeouts, cancellation, and response
  size caps.
- **G-7 — Supply-chain hardening:** Frozen lockfiles, dependency overrides,
  lifecycle-script restrictions, blocking audits, and SHA-pinned CI actions are
  present. Content-addressed dependency/build-image verification and broader
  provenance remain production gates.
- **G-8 — Generated-code enablement:** The gate remains CLOSED. The static sink
  test is only a tripwire and cannot establish sandbox isolation. Every
  invariant and adversarial test in `GENERATED_CODE_GATE.md` requires
  independent verification before any PILOT decision.
