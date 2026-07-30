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
  Serialized JSON snapshot ceilings before Zod and cumulative item, point,
  evidence reference, and USGS observation budgets limit multiplicative schema
  shapes.
- Each parser serializes once and validates only the plain JSON snapshot parsed
  from that same text. Validation never rereads the original accessor-bearing
  object; hostile access failures return fixed sanitized errors with no
  attacker exception or cause.
- Dashboard evidence and freshness timestamps must be internally ordered, and
  `fresh` requires a latest observation timestamp. The schema cannot derive a
  universal freshness-age threshold: status derivation remains trusted
  domain/planner policy.
- Generated-code enablement still requires every invariant and adversarial
  check in the gate document; this work does not relax that decision.

## Input-boundary controls

The DashboardSpec object boundary serializes exactly once, rejects
`undefined`, circular or otherwise non-serializable values with a fixed
sanitized error and no cause, measures the resulting UTF-8 text against the
1 MiB ceiling, and parses that same text. Zod and every semantic check consume
only the resulting accessor-free plain snapshot. Its global budgets cap 2,000
total items, 10,000 trend points, and 10,000 evidence references, while each
`evidenceIds` array is capped at 32.

The USGS object boundary applies the same single-read snapshot process with a
5 MiB serialized UTF-8 ceiling. Zod, observation-time ordering, and
normalization consume only that snapshot. The cumulative budget is 20,000
observations across all series and value groups, and every observation must be
at or before `queryInfo.creationTime`. These limits are exported constants, and
the checked-in fixture and current deterministic planner output remain
unchanged.

These are object-snapshot ceilings, not early raw-ingress byte limits.
`JSON.stringify` must still traverse the input object and allocate its
representation before the ceiling can be measured. Any future HTTP, upload,
model, or connector ingress must enforce raw request or response byte limits
before object construction or `JSON.parse`, then apply these snapshot and
schema controls as defense in depth.

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

The controller reran both dependency audits as part of the complete post-remediation gate sequence:

| Audit                   | Exact command                          | Result                    |
| ----------------------- | -------------------------------------- | ------------------------- |
| Full dependency graph   | `pnpm audit --audit-level high`        | PASS — no vulnerabilities |
| Production dependencies | `pnpm audit --prod --audit-level high` | PASS — no vulnerabilities |

CI fails for vulnerabilities of severity high or critical. Any ignored advisory
requires a CVE-specific entry under `pnpm-workspace.yaml` `auditConfig` and a
rationale row in this document.

Audit exceptions: none.

## Qwen 3.8 review findings — reconciled dispositions

The three-row table below is the durable reconciled record. The raw review
transcript was controller input used to create this record, not a repository
dependency; reproducing or interpreting the table requires no external
transcript file.

| ID     | Finding                                                                                                                | Severity    | Disposition            | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------ | ---------------------------------------------------------------------------------------------------------------------- | ----------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Q38-01 | The report claimed `z.number()` accepts `Infinity` and `-Infinity`, allowing non-finite gauge and trend values.        | Minor (Low) | `not-applicable`       | Installed Zod 4.4.3 rejects `Infinity`, `-Infinity`, and `NaN` through `z.number()`; `.finite()` is redundant for this installed version.                                                                                                                                                                                                                                                                                      |
| Q38-02 | Summary claims and metric cards used content-derived React keys, allowing collisions when text or labels repeat.       | Minor (Low) | `fixed-in-this-branch` | DashboardSpec validation requires claim-text and metric-label uniqueness within each component, and the renderer uses component-scoped positional keys. Tests cover schema rejection and clean rendering.                                                                                                                                                                                                                      |
| Q38-03 | DashboardSpec and USGS collections lacked upper bounds, creating future resource-consumption and renderer spread risk. | Minor (Low) | `fixed-in-this-branch` | Fixed for the precise fixture-foundation object-processing scope: declared strings and arrays are bounded; single-read serialized JSON snapshot ceilings precede Zod; cumulative DashboardSpec item/point/evidence-reference and USGS observation budgets constrain validated shapes. This does not claim an early raw-ingress limit; future network, upload, model, or connector paths must enforce raw bytes before parsing. |

## Qwen production and pilot gaps (G-1 through G-8)

These are durable future gates from the Qwen transcript. They are not claims
that the fixture-only foundation is production-ready.

- **G-1 — Content Security Policy:** No deployment CSP is configured. A reviewed
  CSP remains required before deployment.
- **G-2 — Resource bounds:** The reported unbounded-array gap is remediated:
  every declared nested array and string has a limit, with serialized object
  snapshot and global complexity budgets. Future live ingress still requires
  raw-byte enforcement before object construction or JSON parsing, and all
  limits must be reviewed against the live workload.
- **G-3 — Authentication and tenant isolation:** Authentication, authorization,
  organization scoping, and tenant isolation do not exist and remain production
  gates.
- **G-4 — Rate and edge request controls:** Schema byte limits are defense in
  depth, not early raw-ingress enforcement or rate limiting. Raw request and
  response size enforcement before parsing, parsing timeouts, cancellation, and
  rate limits remain required before network input.
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
