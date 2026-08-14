# Dasher Project and Process Efficiency Review

Status: Review — advisory, no gate outcome
Date: 2026-08-12
Reviewed commit: `d01eedce8bff84d54dd79f98d9b3b95e9d40dcdd`
Reviewed tree: `d1143b52e2b75084d8deb71536537eb96724a4d2`

## Scope and standing

This review answers two questions: is the work correct, and is it efficient. It
is advisory. It does not pass, fail, or modify any gate, and it does not change
the accepted roadmap or any ADR. Every count below was measured against the
reviewed tree; judgements are labelled as such and separated from measurements.

The companion proposal is
[Proposed re-sequencing](../roadmap/2026-08-12-proposed-resequencing.md).

## Summary

The engineering craft in this repository is high. The code is careful, the
safety invariants are enforced mechanically rather than promised, and the status
documents describe their own shortfalls accurately — including where a gate did
not pass and where a validation was synthetic. That honesty is rare and it is
worth preserving.

The finding of this review is not about quality. It is about allocation. After
13 calendar days and roughly 209,000 lines, the running program is one static
page rendering 20 observations from a committed fixture, and about 95% of the
codebase is unreachable from it. The most expensive machinery in the repository
verifies a database schema that no application code calls, using a technique
that requires the same schema to be written out five to seven times by hand.

## Measured baseline

Repository totals at the reviewed tree: 133 files, ~209,000 lines, 71 commits
(61 non-merge, 10 merges) between 2026-07-30 and 2026-08-11. Commit authorship
is `Hermes Agent` 50, `alindebergASL` 19, `Ubuntu` 2.

Composition:

| Area                | Lines  | Share |
| ------------------- | ------ | ----- |
| Test files          | 75,213 | 36%   |
| SQL migrations      | 43,712 | 21%   |
| Non-test TypeScript | 43,498 | 21%   |
| Test fixtures       | 26,798 | 13%   |
| Documentation       | 13,925 | 7%    |
| `apps/web`          | 3,290  | 1.6%  |

Package sizes and reachability, by import trace across the workspace excluding
`node_modules` and the lockfile:

| Package                      | Lines   | Imported outside its own tests |
| ---------------------------- | ------- | ------------------------------ |
| `@dasher/control-plane`      | 164,228 | no                             |
| `@dasher/calculation-engine` | 17,399  | no                             |
| `@dasher/dashboard-schema`   | 4,453   | yes                            |
| `@dasher/river-domain`       | 1,397   | yes                            |

`apps/web/package.json` depends on `@dasher/dashboard-schema` and
`@dasher/river-domain` only. The sole importer of `@dasher/control-plane`
anywhere in the repository is its own `src/public-exports.test.ts`. There is no
importer of `@dasher/calculation-engine` at all.

## What is working

These are load-bearing strengths, not consolation.

- `packages/river-domain` (841 source lines) is clean, well-tested domain code.
  `metrics.ts:106-109` refuses to classify a trend when the stage reading is not
  fresh, rather than emitting a confident direction from stale data, and
  `metrics.ts:76-92` distinguishes missing from stale per sensor.
- The Architecture dialog labels its AI node
  `"Not used in this deterministic demo"` (`river-domain/src/dashboard.ts:427`)
  instead of implying a capability that does not exist.
- The generated-code gate is enforced by a literal
  `grep -qx 'Status: CLOSED'` step in CI, not by convention.
- GitHub Actions are SHA-pinned and the PostgreSQL service image is
  digest-pinned.
- `docs/status/2026-08-04-lifecycle-foundation-and-task-9-planning-baseline.md`
  states plainly that Gate 2 remains `PARTIAL — NOT PASSED`, that the merged
  lifecycle source is not deployed, and that the web application remains a
  deterministic fixture surface.
- `README.md` and the roadmap decline to overclaim the six-agent Gate 1
  rehearsal, naming it synthetic and noting that provider diversity is not
  six-way.

## Finding 1 — the value hypothesis is untested while its infrastructure is finished

`docs/product/PRODUCT_REQUIREMENTS.md:46` defines the product's wow moment: the
user states what they want to monitor and Dasher selects the gauges, metrics,
and visualizations. `apps/web/app/page.tsx` is 24 lines. It imports one fixture,
hardcodes `asOf: "2026-07-29T12:02:00.000Z"` and one demo threshold, and renders
a shell. There is one route, no input control of any kind, no upload, no fetch,
and no persistence.

The accepted roadmap places the model planning loop at Gate 5 of 7. Work is
currently at Task 9C of 9G, inside Gate 2, which has not passed. Gate 1 was
accepted on a six-agent synthetic rehearsal with no human sessions
(`docs/roadmap/2026-07-30-private-pilot-roadmap.md:95-110`).

The consequence is a sequencing inversion: the assumption carrying the most
product risk — that a model can plan a useful dashboard from one sentence — is
scheduled behind the multi-tenant control plane, and remains entirely untested
after two weeks of full-time output. Every downstream design in the repository,
including the calculation graph contract and the run ledger, is specified
against that untested assumption.

This is a judgement, not a measurement, and the sequencing decision is the
owner's. It is recorded here because the cost of the ordering compounds with
every additional slice built on the unvalidated end.

## Finding 2 — verification by hand-maintained duplication

This is the largest mechanical drag in the repository.

`packages/control-plane/src/migrator.ts` is 24,077 lines. Approximately 19,000
of those (79%) are literal data; roughly 5,000 lines are executable logic.

- `modeled0003FunctionSources` (`migrator.ts:719-5003`) — 4,285 lines holding 26
  PL/pgSQL function bodies copied verbatim from the `.sql` migrations.
- `modeled0003StaticCatalogContract` (`migrator.ts:7037-19595`) — 12,559 lines,
  a hand-written `pg_catalog` inventory that repeats the same function bodies
  again in JSON-escaped form.
- `assertStaticModeled0003FunctionSources()` (`migrator.ts:19988`, invoked at
  module load, `:20007`) exists solely to assert that those two copies inside
  the same file agree.
- The fixture `test/fixtures/migrations-0003-allowlist/modeled-0003-inventory.ts`
  (23,950 lines) is an independently maintained third copy, and it carries the
  same self-consistency assertion at `:4122` because it too contains two copies
  internally.

One function body, `dasher_api.list_dashboards`, exists as SQL text in seven
places: `migrations/0003_immutable_content.sql`,
`migrations/0004_lifecycle_api_correction.sql`, twice in `migrator.ts`, once in
`modeled-0003-function-sources.json`, and twice in `modeled-0003-inventory.ts`.

Alongside the bodies, the tree pins 111 distinct SHA-256 literals, per-routine
MD5 digests (`migrator.ts:6856`), catalog fingerprints documented as
intentionally not derived from any migration file at runtime
(`migrator.ts:21866`), and exact byte lengths of migration files
(`canonical-migrations.test.ts:3042`, `expect(Buffer.byteLength(sql)).toBe(482_279)`).
Checksums have also propagated into prose
(`docs/status/2026-08-04-lifecycle-foundation-and-task-9-planning-baseline.md:18`).

Editing one migration therefore requires updating roughly 14 sites across five
files, several of which exceed 20,000 lines. The commit record shows the
resulting amplification directly:

| Migration     | SQL lines | Commit    | Insertions | Files | Amplification |
| ------------- | --------- | --------- | ---------- | ----- | ------------- |
| `0005`        | 20        | `a9625c6` | 939        | 4     | 47×           |
| `0006`        | 489       | `1aab2a0` | 5,783      | 6     | 11.8×         |
| `0004`        | 2,422     | `37d14f5` | 5,014      | 5     | 2.1×          |
| `0007`+`0008` | 30,614    | `3a031f0` | 56,395     | 8     | 1.8×          |

`0005_security_definer_cleanup_coordination.sql` is 20 lines — one `GRANT` and
one `CREATE POLICY`. Landing it cost 939 lines across four files. The practical
floor for any schema change is several hundred lines of TypeScript.

The intent is sound and should be stated clearly: proving that the deployed
schema is exactly the reviewed schema is a real safety property, and for a
multi-tenant system holding customer data it is worth paying for. The issue is
that the implementation makes the hand-typed copy the source of truth rather
than a derived check, so the cost is paid on every edit forever rather than once.

## Finding 3 — the duplication is enforced by policy

`canonical-migrations.test.ts:3386` asserts that both catalog manifests contain
no `Object.keys(`, `Object.entries(`, `.map(`, `.flatMap(`, or `.filter(`, via a
regex named `forbiddenInference`. A companion test at `:3337` reads
`migrator.ts` as text and regex-counts field occurrences to prove the two
hand-maintained catalogs agree.

Any attempt to remove the duplication by deriving one manifest from the other,
or either from the `.sql` files, fails CI by design.

This matters for how Finding 2 can be acted on. Generating the manifests instead
of typing them is not a refactor available to a contributor; it is a reversal of
an explicit, deliberately guarded design decision. It requires an owner decision
and the removal of that guard. The trade-off is stated in the companion
proposal rather than assumed here.

## Finding 4 — the same strategy is now being extended to calculations

`migrations/0007_agent_run_ledger_and_calculations.sql` is 24,704 lines, of
which 19,741 (80%) sit inside `$function$` bodies. It is hand-written, not
generated. The largest single routines are a 1,748-line calculation-graph
evaluator (`:12766`) and a 1,696-line purge routine (`:22161`). Forty-two
percent of its non-blank lines are exact duplicates of another line in the same
file; `RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'dasher_invalid';`
appears 193 times.

`dasher_private.evaluate_calculation_graph_v1` takes
`(p_graph_bytes, p_result_bytes, p_input_bytes, p_meter)` and returns `boolean`
— it re-derives a calculation result in PL/pgSQL to verify one computed
elsewhere. `packages/calculation-engine/src/evaluate.ts` (1,562 lines, merged in
`d01eedc` as Task 9C) implements the same evaluation semantics in TypeScript.

The consequence: decimal rounding, currency conversion, grouping, and window
ordering must now be implemented identically in two languages and kept
bit-identical indefinitely. Neither implementation is imported by any
application code.

Independent re-derivation is a legitimate defense-in-depth technique, and for
financial calculations under adversarial input it may well be justified. The
observation here is narrower: the second implementation is being paid for
permanently, before any user has exercised the first, and before the product
loop that would consume either one exists.

## Finding 5 — rework is structural rather than incidental

- 30 of 61 non-merge commit subjects (49%) contain _close_, _correct_, _gap_,
  _fix_, _harden_, _complete_, _align_, or _reconcile_.
- Three of eight migrations exist only to correct earlier migrations:
  `0004_lifecycle_api_correction.sql`,
  `0006_lifecycle_access_retention_guard_correction.sql`, and
  `0008_retention_lock_authority_correction.sql`. `0008` corrects `0006`, which
  was itself a correction, and it landed in the same commit as `0007`.
- `migrator.ts` has accumulated +34,582 / −10,505 to reach 24,077 lines. Thirty
  percent of every line ever written to that file was later deleted.
- Task 8A required 8 commits across 3 pull requests, +72,243 / −14,469 lines,
  over roughly 30 hours. `e988870` froze the migration contract at 17:29 on
  2026-08-01; it was amended four times over the following four hours
  (`b73ebd7`, `bd1c51b`, `6b46d35`, `2b79c66`), and `c5ff7f7` deleted 8,921 of
  its `migrator.ts` lines the next day.

Two commit subjects in that sequence are near-identical — `close Task 8A catalog
review gaps` and `close task 8a catalog review gaps` — separated by one claiming
`complete exact Task 8A catalog closure`.

The pattern this indicates: contracts are being frozen before the problem is
understood well enough to freeze them, and each premature freeze costs a full
review cycle to reverse. Findings 2 and 3 amplify this, because every thaw
touches five hand-synchronised files.

## Finding 6 — commit size defeats review

`3a031f0` is +56,395 / −459 with the subject
`fix(control-plane): admit authorized phase to run-lock policies (R16)`.
`c5ff7f7` is +47,135 / −12,053. Both carry `SPEC-APPROVE` and `SEC-APPROVE`
attestations in their bodies.

A diff of that size cannot be reviewed by reading it. The attestations on those
two commits record that a process ran, not that a defect would have been caught.
Given that this project's safety argument rests on review of exact heads, the
gap between the attestation and what it can actually assure is worth closing.

## Finding 7 — planning artifacts exceed their output

`docs/plans/2026-08-04-agent-run-ledger-and-deterministic-calculations.md` is
6,471 lines — roughly twice the size of the entire shipped application. It is
marked `Status: Proposed — docs-only planning; implementation HOLD` and
explicitly forbids itself from changing source, tests, packages, CI, lockfiles,
or migrations. Documentation totals 13,925 lines; ADR-005 is 950 lines and
remains `Proposed`.

Specification precision is a genuine virtue and part of why this codebase is
careful. The measured concern is bet sizing: a 6,471-line specification is a
large commitment made before any feedback, and Finding 5 shows commitments of
this kind being repriced within days of being frozen.

## Finding 8 — continuous integration waste

`.github/workflows/ci.yml`:

- Line 49 runs `pnpm audit --prod --audit-level high` immediately after line 47
  runs `pnpm audit --audit-level high`. The production dependency set is a
  subset of the full set and the audit level is identical, so the second step
  cannot fail unless the first already has.
- Line 43 runs `playwright install --with-deps chromium` with no cache — an apt
  install plus a browser download on every run.
- The `verify` job is a single serial chain, so a `format:check` failure is
  reported only after install, and the remaining gates never start.

Separately, all five workspace packages declare `"lint": "tsc --noEmit"`, which
is byte-identical to their own `typecheck` script. The root `lint` script is
`eslint . --max-warnings 0` and never invokes them, so those five entries are
dead.

The fixes for this finding are applied in the same change as this review, since
they carry no product or security consequence. Everything else in this document
is left as a decision.

## Recommendations

Ordered by leverage. Items 1 through 3 are owner decisions in the sense of
`docs/roadmap/2026-07-30-private-pilot-roadmap.md:373-387`; they cannot be
inferred from passing tests.

1. **Test the value hypothesis before building further beneath it.** Run the
   fake-provider harness against the existing fixture, single-tenant, with no
   database. The accepted roadmap already requires that mode to operate with
   zero network and zero credential access, so it has no genuine dependency on
   Gate 2. Detail in the companion proposal.
2. **Decide the dual-evaluator question before Tasks 9D–9G build on it.** Either
   the PL/pgSQL and TypeScript evaluators are both permanent, and the cost of
   keeping them bit-identical is accepted explicitly, or one is authoritative.
   Deciding after 9G is more expensive than deciding now.
3. **Decide whether the catalog manifests stay hand-authored.** Deriving them
   from the `.sql` files preserves the safety property — the committed manifest
   is still checked against the live catalog — while removing the 14-site
   lockstep edit and the 47× amplification. It requires removing the
   `forbiddenInference` guard at `canonical-migrations.test.ts:3386`, which is a
   deliberate reversal, not a cleanup.
4. **Freeze contracts after an end-to-end slice works, not before.** Task 8A and
   the 30% churn in `migrator.ts` are the evidence that the current freeze point
   is too early to be economical.
5. **Cap reviewable pull request size** at a size a person can actually read —
   roughly 2,000 lines of non-generated diff — and stop applying approval
   attestations to diffs above it.
6. **Resolve `@dasher/calculation-engine`'s status.** With zero importers it is
   either the foundation of the next slice, in which case wiring it to
   `river-domain` would validate it, or it is inventory.

## What this review did not assess

- Correctness of the SQL security model. RLS policies, `SECURITY DEFINER`
  boundaries, role grants, and lock ordering were not audited for defects. The
  volume alone precludes it, which is itself part of Finding 6.
- Runtime performance of anything. No code was executed against a database.
- The `pnpm test:postgres` integration suite, which requires a live PostgreSQL
  instance not available in the review environment.
- Whether the six-agent Gate 1 rehearsal supports its accepted conclusion. That
  is recorded as an explicit owner decision and is out of scope here.
- Front-end accessibility, visual design, and browser compatibility beyond
  reading the existing Playwright specifications.
