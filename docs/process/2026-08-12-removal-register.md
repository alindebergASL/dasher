# Removal Register

Status: Advisory — candidates for deletion, no gate outcome
Date: 2026-08-12
Owner direction: work that does not function, is not right, or holds the project
back may be removed regardless of effort already spent.
Relates to: [ADR-006](../architecture/ADR-006-schema-freeze-point.md),
[Working practice](2026-08-12-working-practice.md)

## The principle

**Delete what blocks. Keep what merely sits.**

Dead code that is not in anyone's way costs approximately nothing to keep, and
removing it is tidying rather than progress. Code that imposes a tax on every
future change is different: it compounds, and every day it survives it costs
again.

That distinction decides every entry below. `@dasher/calculation-engine` has zero
importers and is not on this list, because nothing is slower for its existing.
The hand-authored catalog manifests have a measured 47× tax on the smallest
migration, and they are first.

Deletion is not free — each entry needs enough review to be confident nothing
load-bearing goes with it. That cost is why this is a register and not an
instruction.

---

## Tier 1 — Delete now. Blocks actively, high confidence.

### 1.1 The hand-authored catalog manifests

**What.** The literal-data portions of `migrator.ts`, the entire
`modeled-0003-inventory.ts` fixture, the manifest-comparison tests in
`canonical-migrations.test.ts`, and the `forbiddenInference` guard at
`canonical-migrations.test.ts:3391` that forbids replacing them.

**Measured size.**

| File                           | Total  | Deletable (estimate)                              |
| ------------------------------ | ------ | ------------------------------------------------- |
| `migrator.ts`                  | 24,077 | ~19,000 (79% is literal data; ~5,000 is logic)    |
| `modeled-0003-inventory.ts`    | 23,950 | 23,950 (a second hand-maintained copy)            |
| `canonical-migrations.test.ts` | 25,998 | ~15,000 (literal blocks and copy-agreement tests) |
| `migrator.test.ts`             | 6,747  | ~2,000                                            |

**Roughly 60,000 lines — about 29% of the repository.**

The first, third, and fourth are in `packages/control-plane/src/`; the fixture is
at `packages/control-plane/test/fixtures/migrations-0003-allowlist/`.

**Replaced by.** A generator that reads `migrations/*.sql` and emits the checksum
manifest and catalog inventory to a committed file, plus a test asserting the
committed file matches a fresh regeneration.

**What is lost.** The guarantee that expected values were typed by a human
independently of the migration. That independence is real. It has never caught a
defect the live-catalog comparison would have missed.

**What is preserved.** The actual safety property: the deployed schema is still
proven equal to the reviewed schema, and the manifest stays committed and
diffable.

**Why it blocks.** 47× amplification on migration `0005`; roughly 900 lines of
TypeScript as the floor for any schema change; ~14 lockstep edit sites. Every
migration added makes it worse, and the Task 9D status report describes four more
(`0009`–`0012`) written against this surface but not yet committed to `main`.

### 1.2 One of the two calculation evaluators

**What.** Either `dasher_private.evaluate_calculation_graph_v1` (~1,748 lines of
PL/pgSQL inside `0007`) or `packages/calculation-engine/src/evaluate.ts` (1,562
lines of TypeScript). Not both.

**Recommendation: delete the PL/pgSQL one.** The TypeScript engine is testable,
debuggable, iterable, and already carries 303 passing tests. A stored procedure
inside an immutable migration can be changed only by writing another migration,
and cannot be unit-tested in isolation. Independent re-derivation is a legitimate
technique, but paying for it in the medium that is hardest to change, at zero
users, is the wrong half to keep.

**What is lost.** Database-side verification that a computed result matches an
independent implementation.

**Why it blocks.** Task 9F builds an adversarial conformance surface across both.
After 9F, the cost of removing either roughly doubles. This is the deadline.

### 1.3 Verification wrappers that can hide failures

**What.** Any harness script lacking `set -e` or equivalent failure propagation.

**Why.** One was found producing false-green results — a failed `pnpm test`
masked by a later successful build. Every prior "gates PASS" from that wrapper is
of unknown value. Others are unaudited.

**Effort.** Minutes to audit. Highest ratio of confidence gained to work done on
this entire list.

### 1.4 The session and invitation repositories — REMOVED 2026-08-14

**What.** `session-repository.ts` (1,530), `invitation-repository.ts` (1,172),
and their unit tests (1,244 and 1,882). 5,828 lines.

**Why.** They call seven SQL functions that do not exist:
`initialize_context`, `issue_session`, `rotate_session`, `revoke_session`,
`issue_invitation`, `change_membership_role`, `revoke_membership`. The eighth
name they use, `accept_invitation`, does exist but takes seven arguments where
the repository passes twelve. Every one of these calls fails at the first line
of SQL the database parses.

This is not code that merely sits. It was a **public export** of
`@dasher/control-plane`, with 119 passing unit tests, so it read as working
infrastructure. Anyone starting the sign-in work — the piece the forward plan
names as the real blocker to a pilot — would have started here and spent the
first day discovering that none of it can run. That is the tax this register
exists to charge for.

The unit tests passed because they inject a fake client that returns canned
rows. No mock can detect a function that does not exist; only the database can.
That is a defect in the testing approach, not merely in this code, and it is
addressed separately by preparing every repository statement against a migrated
schema.

**What was kept.** `secrets.ts`, `session-cookie.ts`, `verified-principal.ts`,
and `email.ts` are untouched. They contain no SQL, they are independently
correct and tested, and real session and invitation code will want them. They
now have no consumer inside the package, which is worth knowing when the
reachability gate lands.

---

## Tier 2 — Delete via the Freeze Point. Requires ADR-006.

### 2.1 The disposable-dashboard machinery

**What.** `current_kind`, expiry columns, promotion and its race handling,
quarantine, purge finalizers, retention claims, restore-as-new, tombstone
lineage, the backup-deletion ledger, and the retention-operator role apparatus.

**Status.** The product feature is already cut by owner decision. The schema
survives because migrations froze at authorship. It can only be removed by
squashing to a baseline before a Freeze Point is declared.

### 2.2 The correction migrations

**What.** `0004`, `0006`, `0008`, and whichever of `0009`–`0012` exist only to
correct predecessors. Three of eight migrations existed solely as corrections
before this week; the ratio has since grown.

**Status.** Same mechanism. In a squash they simply do not appear — their content
is already folded into the corrected state.

**Note.** Superseded files should move to `migrations/archive/`, unreferenced,
rather than being destroyed. Provenance is worth keeping; reachability is not.

---

## Tier 3 — Descope rather than delete. The largest single reduction.

### 3.1 Most of Task 9D–9G

This is the biggest item on the list and the least comfortable, so it is stated
carefully.

Task 9 builds an agent-run ledger, lease epochs, budget reservation and
reconciliation, checkpoints, content-addressed replay, claims, evidence
manifests, and a calculation AST. Consider what each protects against, today:

| Component                    | Protects against                             | Exists today?          |
| ---------------------------- | -------------------------------------------- | ---------------------- |
| Budget reservation, metering | cost overruns from live inference            | no live provider       |
| Lease epochs, fencing        | concurrent workers committing stale work     | no worker process      |
| Content-addressed replay     | re-calling providers                         | no provider is called  |
| Checkpoints, resume          | interrupted long-running runs                | no long-running runs   |
| **Claims, ClaimEvidence**    | **unsupported statements reaching a reader** | **the differentiator** |
| **Calculation AST**          | **model-proposed arithmetic**                | **built, 9C**          |

Four of six protect infrastructure that does not exist. Two are the product.

**Proposal.** Keep claims, ClaimEvidence edges, and the evidence manifest —
that is ADR-005's epistemic contract and the reason anyone would trust the
output. Defer ledger, lease epochs, budget accounting, checkpoints, and replay
until a live provider and a worker process exist to need them.

**Effect.** Task 9F, the 298-line adversarial gate that is the largest remaining
task in the plan, largely evaporates, because most of what it exercises would not
yet be built.

**Honest counter.** Retrofitting fencing into an existing ledger is genuinely
harder than building it in. That argument is real, and it is the same argument
ADR-003 made for tenancy — which is now the largest thing in the repository that
no user has touched. The counter to the counter: none of this is deployed, so the
retrofit cost is hypothetical while the carrying cost is being paid now.

### 3.2 The Task 9 plan itself

**What.** 6,471 lines of specification, of which roughly 4,000 are enumerative
tables, byte vectors, and catalog matrices.

**Proposal.** Rewrite as invariants and interfaces — a few hundred lines. Under
the "specify invariants, not implementations" change, this document is precisely
the artifact being replaced, and it is the one making 9D–9G intractable to review.

---

## Explicitly keep

Not on this list, and should not be:

- **`apps/web`, `river-domain`, `dashboard-schema`** — the working product and
  its contracts.
- **Forced RLS, composite tenant foreign keys, restricted runtime roles, audit
  atomicity, record immutability** — the safety properties. These were never the
  problem.
- **The adversarial PostgreSQL suite** — this is the external corrective signal
  that already works. It found a real `COMMIT`-time permission failure. Grow it.
- **Identity, sessions, invitations** — needed, working, well-tested.
- **`@dasher/calculation-engine`** — zero importers, but zero tax. It sits; it
  does not block. Do not extend it until something calls it.
- **`packages/planner`** — currently the only path from a request to a rendered
  dashboard.

---

## Suggested order

1. **Audit the wrappers** (1.3). Minutes, and everything else's evidence depends
   on it.
2. **Decide the evaluator** (1.2) before Task 9F. This is a deadline, not a
   preference.
3. **Decide the Freeze Point** (ADR-006), which unlocks Tier 2 and makes 1.1
   cheaper to do once rather than twice.
4. **Generate the manifests** (1.1). The largest single reduction available and
   the one that stops the bleeding on every future migration.
5. **Revisit Task 9 scope** (3.1) once 9D lands, with the split-atom
   recommendation applied so the work in flight is not wasted.

Items 2 and 3 share a deadline. Item 1 is free. Item 4 is the payoff.
