# Restructure Proposal

Status: Proposed — requires owner acceptance; nothing here is applied
Date: 2026-08-13
Mandate: owner direction that nothing is exempt from review, that no existing
contract or constraint must be preserved for its own sake, and that pre-production
strictness is not justified by production standards.
Relates to: [Removal register](../process/2026-08-12-removal-register.md),
[Drift analysis](2026-08-12-drift-analysis.md),
[Working practice](../process/2026-08-12-working-practice.md),
[ADR-006](../architecture/ADR-006-schema-freeze-point.md)

Measured against `main` at `16dad93` (Task 9D merged).

## 1. What the measurements say

| Measure                                             | Value              |
| --------------------------------------------------- | ------------------ |
| TypeScript, TSX, SQL, CSS in the repository         | 227,199            |
| Reachable from the running program, excluding tests | **6,157**          |
| Share of the codebase the running program can reach | **2.7%**           |
| `@dasher/control-plane`                             | 201,071 (88.5%)    |
| Importers of `@dasher/control-plane`                | **0**              |
| Importers of `@dasher/calculation-engine`           | 1, a test          |
| Routes in the application                           | **1**              |
| Tables defined across all migrations                | **62**             |
| Migration SQL                                       | 56,913             |
| …of which correction migrations                     | **22,032 (38.7%)** |
| Migrations that exist only to correct a predecessor | **7 of 12**        |
| Hand-authored manifest apparatus mirroring that SQL | 58,996             |
| Largest single migration (`0007`)                   | 24,704             |
| Largest correction migration (`0012`)               | **11,839**         |
| Documentation                                       | 17,016             |
| …of which one plan                                  | 7,199              |

`apps/web` imports exactly three packages: `dashboard-schema`, `river-domain`,
and `planner`. Nothing else in the repository is reachable from the thing a user
would open.

Three of these numbers are the whole argument.

**Seven of twelve migrations are corrections.** Immutable forward-only migrations
are a discipline for protecting a deployed database. There is no deployed
database. What the discipline is protecting is a development schema that has been
wrong seven times, and each correction cost more than the fix because the original
could not be edited. `0012` is 11,839 lines containing twenty-two
`CREATE OR REPLACE FUNCTION` statements and one `ALTER FUNCTION` — it re-emits
every function body in order to change function attributes.

**58,996 lines exist to prove that 56,913 lines of SQL are what they say they
are.** The manifest apparatus is a hand-typed second copy of the schema. It exists
because migrations are immutable, so their content must be provable. Remove the
immutability requirement and the proof requirement goes with it.

**2.7% of the code is reachable.** This is not a code-quality finding. It is a
sequencing finding: the project built a control plane, then a ledger, then a
calculation runtime, and has not yet built the path connecting any of them to a
page.

## 2. Testing the things that were treated as fixed

Under the mandate that nothing is sacred, each load-bearing constraint is examined
on its own merit rather than on the fact that it is already accepted.

### Immutable forward-only migrations — **drop until first production deploy**

The strongest cut available. The rule was adopted 2026-07-30 in ADR-003, one day
before the first migration was written, for a database that has never existed.
Since then it has produced seven corrections, one of them 11,839 lines, and a
58,996-line proof apparatus.

Immutability is correct the day real data exists. It is nearly pure cost before
then. Adopt it at first production deploy, not at first `CREATE TABLE`.

### The hand-authored catalog manifests — **delete**

They exist only to serve immutability. Schema equality is better proven by
comparing a committed `pg_dump` against a freshly migrated database — a few
hundred lines that cannot drift by construction, because it is generated rather
than typed.

### Row-level security and composite tenant foreign keys — **keep**

These survive the test. They are cheap to carry in a squashed baseline, they are
correct, and retrofitting them onto a live database is genuinely painful. RLS is a
schema property; keeping it costs a `FORCE ROW LEVEL SECURITY` line per table.

### The multi-role, `SECURITY DEFINER`, allowlist-table apparatus around it — **cut**

This is separable from RLS itself and is where the cost actually is. Several
restricted `NOBYPASSRLS` roles, service-principal allowlist tables, and
`SECURITY DEFINER` wrappers on most write paths enforce a privilege boundary
between components that all currently run in the same Next.js process as the same
database user. There is no boundary yet for them to defend. `0005` and `0012`
exist because of this apparatus.

### Multi-tenancy — **keep the schema, stop gating on it**

Every table carrying `organization_id` is right and costs nothing. What should
stop is treating tenancy as a prerequisite for product work. It is a prerequisite
for real customer data and nothing else.

### The agent run ledger — **cut to three tables**

Sixteen tables currently model agent runs: attempts, payload side-tables, events,
event payloads, budget counters, calculation meters, checkpoints, checkpoint
payloads, policy revisions, recorded results, candidates, candidate payloads,
validation findings, briefs. Budgets, leases, epochs, checkpoints, and replay all
presuppose asynchronous workers and a metered provider. Neither exists. For a
synchronous request that returns a dashboard, what is needed is a record of the
run, the plan it produced, and the result.

### `packages/agent-harness` (Task 9E) — **do not build**

Reviewed separately. Its own file list confirms nothing will import it. Its
replay subsystem proves a cost-avoidance property about a provider that is never
called. `packages/planner` already runs the orchestration loop it would duplicate.

### The generated-code gate — **keep, unchanged**

It is `CLOSED`, it costs nothing while closed, and it guards the one thing that is
genuinely dangerous. This one is not a pre-production luxury.

### Record immutability as a product property — **keep**

Distinct from schema immutability, and frequently conflated with it. That a
published dashboard version cannot be silently altered is a real product
guarantee. That a migration file cannot be edited is a deployment discipline.
Cutting the second does not touch the first.

### Approximately nineteen gates — **cut to four**

Gates multiplied because there was no way to record an accepted risk. Replace with
four — it builds, it is safe, a person used it, real data works — plus a dated,
owner-signed register of what is knowingly not verified.

### The plan format — **replace**

7,199 lines for Task 9, which grew by 738 lines during its own implementation.
A specification that changes while being implemented is being discovered, not
followed. Replace with invariants and interfaces.

## 3. What is worth keeping

Judged on merit, not on effort spent.

| Keep                                                      | Lines  | Why                                                                              |
| --------------------------------------------------------- | ------ | -------------------------------------------------------------------------------- |
| `apps/web`, `planner`, `river-domain`, `dashboard-schema` | 6,157  | The running product and its contracts. Everything else is support for this.      |
| `@dasher/calculation-engine`                              | 17,372 | Genuinely good, 303 passing tests, solves the real problem — **but wire it up**. |
| RLS, composite tenant FKs, `organization_id`              | —      | Correct, cheap in a baseline, painful to retrofit.                               |
| The claims and evidence model                             | —      | The differentiator. Currently schema only; needs to become code.                 |
| The secret key ring design                                | ~450   | Versioned rotation is needed for A1's credential switching.                      |
| Adversarial PostgreSQL testing as a practice              | ~1,000 | It found a real `COMMIT`-time failure. Keep the practice, not 32,178 lines.      |
| Documentation honesty                                     | —      | Every overclaim in this project is labelled by the project. Rare and valuable.   |

`calculation-engine` deserves emphasis. It is the best code in the repository —
pure, deterministic, thoroughly tested — and its only importer is
`postgres.integration.test.ts`, which uses it to cross-check the PL/pgSQL
evaluator. Meanwhile `planner/src/compile.ts` computes displayed values itself.
So there are three implementations of one responsibility: the good one is used
only to check the redundant one, and the running program uses neither.

## 4. What to cut

| Cut                                                                 | Lines      | Mechanism                        |
| ------------------------------------------------------------------- | ---------- | -------------------------------- |
| Manifest apparatus (`migrator` literals, fixture, comparison tests) | ~59,000    | Delete; replace with a generator |
| Twelve migrations                                                   | 56,913     | Squash to one baseline           |
| Retention, disposable, promotion, tombstone, finalizer tables       | ~20 tables | Absent from the baseline         |
| Agent run ledger tables                                             | 16 → 3     | Absent from the baseline         |
| PL/pgSQL calculation evaluator                                      | ~1,748     | Absent from the baseline         |
| PostgreSQL integration test, catalog-shape portions                 | ~31,000    | Keep property tests only         |
| Prototype-capture ceremony                                          | see below  | Delete                           |
| Task 9E                                                             | not built  | Descope                          |

### The prototype-capture ceremony

163 declarations across the repository capture built-ins into module-local
constants — `Array.isArray`, `Map.prototype.get`, `Reflect.apply`,
`Function.prototype[Symbol.hasInstance]` — and roughly 200 call sites then route
through them:

```ts
reflectApply(stringCharCodeAt, candidate, [0]); // instead of candidate.charCodeAt(0)
```

This defends against an attacker who can already monkey-patch built-ins inside the
process, which requires arbitrary code execution in that process. The
generated-code gate is `CLOSED`, so by construction no untrusted code runs there.
The threat is not reachable, and the pattern inflates and obscures every function
it touches — which directly worsens the review-capacity problem that is the real
constraint here.

## 5. The target

One structural change makes everything else possible: **squash to a mutable
baseline and adopt migration immutability at first production deploy.**

Target shape, on the order of 30,000 lines against today's 227,199:

```
migrations/0001_baseline.sql        ~800   10 tables, RLS, composite FKs
tools/schema-snapshot               ~200   pg_dump equality, generated
packages/control-plane              ~3,000 repositories: orgs, sessions, dashboards, versions, runs
packages/calculation-engine         17,372 unchanged — but imported
packages/planner                    ~2,500 + claims and evidence
packages/dashboard-schema           ~1,600
packages/river-domain               1,366
apps/web                            ~2,000 request, dashboard, list, sign-in
tests                               ~8,000 property and adversarial, not catalog-shape
```

Ten tables rather than sixty-two: `organizations`, `users`, `memberships`,
`sessions`, `dashboards`, `dashboard_versions`, `evidence_records`, `claims`,
`claim_evidence`, `agent_runs`.

The product loop this serves is: **request → plan → compute → render → save →
reload → refine.** No part of that loop is finished today; the pieces that exist
are on either side of it.

## 6. Sequence

Each step ends with something a person can look at running. That is the point of
the ordering, not a nicety.

1. **Audit the verification wrappers.** One was found masking a failed
   `pnpm test`. Every prior gate result from it is of unknown value. Minutes of
   work and everything downstream depends on it.
2. **Squash to `0001_baseline.sql`.** Ten tables. Superseded files move to
   `migrations/archive/` unreferenced — provenance is worth keeping, reachability
   is not. Deletes ~56,000 lines of SQL and unblocks step 3.
3. **Replace the manifests with a generator.** Deletes ~59,000 lines. The largest
   single reduction available.
4. **Wire `calculation-engine` into `planner`.** One evaluator, in the language
   that can be debugged, called by the running application. Visible immediately:
   the dashboard renders from it.
5. **Build the persistence slice.** _A dashboard survives a page reload._ Two
   tables, one repository, one route. Perhaps 400 lines, and the first time any
   database code in this project has been reachable from a browser.
6. **Move claims and evidence into the compile step.** Every computed value
   already knows its inputs; a claim is that relationship made durable. This is
   ADR-005's epistemic contract, built where it is observable.
7. **Sign-in.** One path. Evaluate buying before building — no sign-in of any kind
   exists today, and it, not tenancy, is what stands between now and a pilot user.
8. **A live provider** behind the existing `PlanningProvider` interface, with the
   evaluation harness from amendment A2 comparing Qwen, Anthropic, and OpenAI on
   identical inputs.

Steps 1–3 are removal and cost days. Steps 4–6 are the product and are small
because the hard parts are already written.

## 7. Process changes that make this stick

Removing the code without changing the loop that produced it would rebuild it.

- **Done means demonstrated.** A task is unfinished until someone has looked at
  the thing it changed, running. Where that seems impossible, the slice was drawn
  along a layer boundary and should be redrawn.
- **Specify invariants, not implementations.** A few hundred lines of properties
  and interfaces. Verification comes from adversarial tests, not from comparing
  one text to another.
- **A browser in the loop.** Driving the running application during this review
  surfaced a CSS collision, a dropped feature, and a mobile regression — none
  findable by tests the same author would write, because each lived between
  components that were individually correct.
- **Cap what reaches the owner.** Owner attention is the binding constraint, not
  agent throughput. It is uniquely valuable for judging running software and for
  decisions only the owner can make; it is worth nothing spent on a 7,199-line
  plan.
- **A register of accepted risk**, so gates can shrink instead of multiply.

## 8. Honest counters

**Retrofitting is harder than building in.** True, and it is the argument ADR-003
made for tenancy — which is now the largest thing in the repository that no user
has touched. The counter: nothing is deployed, so retrofit cost is hypothetical
while carrying cost is being paid now.

**Squashing discards reviewed work.** It discards reviewed _files_. The schema
they produce is carried forward, and the archive keeps provenance. What is
genuinely lost is the audit trail of how the development schema evolved before it
ever ran anywhere.

**This is a large deletion.** It is. Roughly 190,000 lines, none of it reachable
from the running program, most of it either a copy of something else or a
mechanism protecting a system that does not exist.

**The safety invariants might be needed sooner than expected.** Which is why RLS,
composite foreign keys, record immutability, the generated-code gate, and audit
atomicity are all on the keep list. The cut is aimed at the apparatus around them,
not the properties themselves.

## 9. What this does not propose

No relaxation of the generated-code gate, record immutability, forced row-level
security, composite tenant foreign keys, audit atomicity, or the rule that
deterministic services compute every displayed value. No change to the
documentation's practice of labelling its own overclaims.

> **Correction, 2026-08-13.** The schema first written under this proposal did
> not hold to that paragraph. Independent review found, and adversarial tests
> confirmed, that it relaxed forced row-level security on `memberships` and made
> audit atomicity unreachable — the application role had no `INSERT` privilege
> on `dasher.audit_events` at all.
>
> The cause was a bad distinction in §2. Cutting "the multi-role apparatus" was
> right; that section treated it as a privilege boundary between co-located
> components, when in fact those same functions were the _only_ write path and
> carried actor identity, transition legality, and audit atomicity with them.
> Direct table grants replaced the ceremony and the enforcement together.
> Smaller and less governed are separate choices, and only the first was
> intended.
>
> Twenty-six such states were enumerated as failing tests and have since been
> closed by a write seam, tracked separately. This paragraph is left standing
> rather than edited, because what it claimed and how it failed are both worth
> keeping.

The engineering judgment in this project is good. What needs changing is the
sequence it was applied in.
