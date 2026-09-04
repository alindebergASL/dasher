# Direction and code review, 2026-09-04

Status: Advisory — external review, no gate outcome
Reviewed commit: `dfb3c94` (`main` after PR #58)
Method: full read of every package and `apps/web`, the deploy tree, and the
documents this repository treats as authoritative; three independent deep
passes (web and control plane; planner, schema and engine; domain packages,
tooling and CI); `pnpm install`, `pnpm typecheck` and `pnpm test` run locally
(1,631 tests, green). Every claim below was traced to a file, and the ones
that matter most were re-traced by hand after the deep passes reported them.

The question asked was: is Dasher on the right track, is it making progress,
and what should change — with nothing off the table.

## The short answer

**The architecture bet is right. The execution keeps choosing the wrong work.**

The bet — a model proposes composition, trusted code computes every number,
every displayed claim traces to bytes that were actually retrieved — is
correct and differentiating. Keep it.

But six weeks and 180 commits in, the two assumptions the product rests on
are still untested, exactly as the 2026-08-13 forward plan said they were:

1. **No model has ever planned a dashboard inside the product.** The
   "planner" is a regex router (`apps/web/app/domains.ts:199`) in front of a
   keyword-to-template picker (`packages/planner/src/provider.ts`, `draft`;
   `packages/planner/src/ledger-provider.ts:312`). Five fixed layouts for
   stations, three for ledgers.
2. **No user has ever uploaded their own spreadsheet and got a dashboard.**
   The upload path accepts only Dasher's own CSV template — fixed headers,
   `YYYY-MM` periods, bare numbers, kebab-case ids (`from-csv.ts:33-37`,
   `ledger.ts:52-62`) — and refuses anything over 250 cells
   (`packages/ledger-domain/src/calculation.ts:109`). The code's own comment
   says it: "30 budget lines over 12 months is 360 cells and does not build.
   That is an ordinary operating export."

Everything else that was built since the drift analysis — persistence, claims,
sign-in, backups, a deployable, the free-text gate, exact decimals — is real,
mostly well made, and sits on the far side of those two untested assumptions.
The drift analysis of 2026-08-12 diagnosed a loop with no external signal. The
loop is still running; it has just moved from schema to gates.

## What exists, measured

| Surface                             | Size                                                    |
| ----------------------------------- | ------------------------------------------------------- |
| TypeScript                          | ~67k lines, ~34k of them tests                          |
| Documentation                       | ~180k words across 50 files                             |
| Comment density (non-test source)   | 20–39% by package; `calculation.ts` ~60%                |
| Commit authorship                   | 117 Claude, 58 owner, 5 Hermes                          |
| CI per push                         | 5 jobs, ~35–45 runner-minutes, ~12–15 min wall          |
| Product-reachable code that is dead | ~2k lines in control-plane, 17.5k in calculation-engine |

What a user gets today at `/`: a fixture river dashboard, a request box that
routes to one of four subjects, a folded CSV upload, a refine bar that
understands a handful of section names. Signed in, dashboards save and list.
No delete, no archive, no search, no sharing. `luckbutton.com` currently
answers 401 from nginx, so the Caddy cutover in `deploy/cutover.md` has not
run yet.

## Findings that block a pilot

Ranked. The first three are product-shaped; the rest are defects.

1. **The ledger path cannot take a real ledger.** 250-cell ceiling inherited
   from `calculation-engine`'s `finalOutputRows` limit; a bespoke header
   schema; `49,875.00`, `$500`, `(500)` and blank cells all refused
   (`ledger.ts:52-55`); `parseCsv` supports a delimiter that `from-csv.ts:63`
   never passes. A pilot user would be told to retype their export into
   Dasher's template.
2. **The plan contract cannot express a spreadsheet dashboard.** Even with a
   model enabled, a plan is an ordering of eight fixed station widgets or five
   fixed ledger widgets (`registry.ts:266`, `ledger-plan.ts:146`). It cannot
   name a column, a grouping, a comparison, or a metric. The PRD's second
   slice — transactions with Date, Description, Category, Amount — has no
   representation anywhere.
3. **Two people cannot be in one organization.** `provisionPrincipal` always
   mints a new organization (`provision-cli.ts:126-136`); `begin_sign_in`
   binds an address to its oldest membership (`0004:88-98`); the
   `invitations` table and `accept_invitation` have no caller in TypeScript.
   RLS then correctly hides every dashboard from every colleague.
4. **Sign-in lockout by anyone.** The hourly limit is per address with no
   per-IP throttle anywhere (`0004:113-121`, no match in `apps/web` or
   `deploy/Caddyfile`). Five submissions an hour of a known address locks that
   person out indefinitely. Low exposure while the host sits behind basic
   auth; a real defect the day it does not.
5. **`/` depends on USGS in live mode and 500s on outage.** `page.tsx:19-23`
   plans the default request through `loadDomainSnapshot`; the test that
   claims `/` is off the network greps `page.tsx` for a string
   (`no-source-secrets.test.ts:118-135`) and is wrong;
   `reopen-is-fetch-free.test.ts:87-95` asserts the opposite and is right.
6. **Session state disagrees with itself.** 60-minute idle in `sign-in.ts:38`,
   30-minute refresh hard-coded in `begin_request`, 12-hour cookie; only
   database-touching pages refresh. The header can say "Sign out" while
   `/dashboards` says "not signed in".
7. **Unbounded immutable storage.** Uploads are 4 MB `bytea` rows under an
   insert-only trigger with no quota; `sign_in_challenges` cannot be deleted
   by any role (`0002:62-64`).

## Where the effort went instead

- **`calculation-engine`**: 17.5k lines built from a 7,199-line plan. One
  consumer, using six of ~40 ops with contract conformance skipped
  (`ledger-domain/calculation.ts:448-457`); the river and air paths compute in
  floats and never touch it. It was wired to the ledger to satisfy the
  reachability gate rather than deleted, and the wiring imported the 250-cell
  ceiling plus a 684-line adapter and a second decimal library (`exact.ts`).
  `exact.ts` alone delivers the correctness that was wanted.
- **Tests of prose and of tests.** `gate-contracts.test.ts` (2,542 lines) asserts
  that roadmap sentences appear verbatim; `freshness.test.ts` pins the numbers
  quoted in a write-up; engine tests pin SHA digests the implementation
  produced; `preflight.test.ts` tests the test harness; 900 lines of contrast
  tooling; 1,200 lines testing `secrets.ts` and `verified-principal.ts`, which
  nothing imports.
- **Speculative machinery.** A deprecation lifecycle for a registry with no
  deprecated entry; four registry fields read only by tests; production
  injection of fake unavailable river sites so attempt one fails "realistically"
  (`provider.ts`, `UNAVAILABLE_RIVER_SITES`); 350 lines of `compose.ts` for
  the one river-plus-air case; a feedback dialog whose data goes nowhere
  (`dashboard-shell.tsx:116-307`); prototype-pollution-hardened JS for an
  email lowercaser.
- **Two experiment packages** still in the workspace: `enrollment-domain` ships
  a hand-written spec literal and never runs its parser; `extraction-spike`
  answered its question on 2026-08-19 and the answer is in prose.
- **Documents about the process.** Retrospectives, an enablement checklist, a
  note that opens with a correction to itself, a working-practice doctrine.
  Individually honest; collectively 180k words a single owner has to keep
  current, and the README's safety status is already stale on three counts
  (live USGS, uploads and identity all exist).

The pattern: work that can be verified by enumeration keeps winning over work
that can only be verified by a person looking at a screen. That is the
mechanism the drift analysis named, one layer up.

## Recommended course changes

In order. Each is a decision, and the first three change what the product is.

**1. Make the spreadsheet the product; make the river a demo.** The accepted
roadmap's pilot criterion is three organizations building from their own
workbook. Put the upload on the front of `/`, stop investing in station
composition (packing, river-plus-air, emergency phrasing), and keep the river
fixture as the live-source demo it was meant to be. This also dissolves the A5
alerting liability: a spend dashboard has no evacuation problem, so the legal
review stops blocking a pilot user.

**2. Turn the model on, in development, now.** The enablement checklist says
the blocker is one decision — the dynamic-import tripwire. Take it: narrow the
rule to non-literal specifiers, promote the SDK to a dependency, put the
Anthropic provider behind `DASHER_PLANNER=anthropic` defaulting to fake. For an
owner-only deployment the five ADR-005 controls reduce to two: an environment
kill switch and a daily spend cap. Build those two. The fake provider stays
the test substrate, as the working practice already says.

**3. Let the plan describe a table, not pick among widgets.** One plan schema
with a `source` discriminator. The model proposes column roles (date,
category, amount, account, budget), a metric list from a small typed
vocabulary (sum by group by period, change against prior, share of total,
top N, budget variance), and layout. Trusted code computes with `exact.ts`.
This is the PRD's "typed calculation graph" at a twentieth of the engine's
size, and it collapses the two parallel station and ledger pipelines
(`compile.ts`, `compile-ledger.ts`, two validators, two plan schemas) into one.
Support the transaction shape first; the pivoted budget shape is a special
case of it.

**4. Accept real exports.** Header mapping (model-assisted, with the fake
provider mapping by name), tolerant amounts, delimiter detection, blank cells,
and no cell ceiling beyond the byte cap. Drop `calculation.ts` and compute the
four figures directly.

**5. Cut. Roughly 30k lines and half of CI can go without losing a user-visible
behaviour:**

| Delete                                                                                      | Lines (approx.) |
| ------------------------------------------------------------------------------------------- | --------------- |
| `packages/calculation-engine` (keep `decimal.ts` merged into `exact.ts`)                    | 17,500          |
| `packages/extraction-spike` and its fixtures                                                | 1,900           |
| `packages/enrollment-domain`, its fixtures and router branch                                | 700 + 130 KB    |
| `control-plane/src/secrets.ts`, `verified-principal.ts` and tests                           | 2,000           |
| `gate-contracts.test.ts`, `private-pilot-gate-boundaries.json`, `freshness.test.ts` numbers | 2,900           |
| Registry deprecation lifecycle and test-only fields                                         | 500             |
| `SessionFeedbackDialog`, contrast tooling, `preflight.test.ts`                              | 1,400           |
| `repo-graph` → one reachability script or `knip`; `workflow.test.ts` → actionlint alone     | 700             |

And: run Stryker on a schedule, not as a push gate; merge `persistence` into
`verify` as one Playwright run; drop the duplicated `Status: CLOSED` grep and
clean-tree steps. Keep `invitations` — build its caller instead (finding 3).

**6. Fix the defects in findings 3–7.** Provisioning into an existing
organization (or wire `accept_invitation`); a per-IP throttle at Caddy or in
the action; `/` renders the fixture without planning; one idle-timeout number;
an upload quota per organization; deletable challenges.

**7. Freeze the document corpus.** One live `STATUS.md` — what works, what is
next, known gaps — replacing the README safety block. ADRs only for
irreversible decisions. No more retrospectives or process essays until a
second person has used the product. Move changelog comments to git; they are
already rotting in four places (`ledger.ts:30-33`, `vitest.stryker.config.ts`,
`ci.yml`'s "river composition rules", the README).

**8. Change the acceptance test.** The drift analysis' remedy was an external
signal. Make it concrete: every week the owner uploads a spreadsheet they did
not author, with the model on, and either the dashboard is useful or the next
week's work is whatever made it not. Every PR must change something on a
screen or delete something. Diffs a person will read.

## What to keep, and say so

`parseDashboardSpec` and the component schema; `layout.ts`; `canonical.ts`;
`run.ts`'s revise-and-retry loop; `station-domain` facts and metrics;
`workbook/csv.ts`; `exact.ts`; the free-text detector as defence in depth; the
cookie → repository → `begin_request` → RLS seam, which is better than most
pilots ship; digest-only token storage, single-use redemption, the CSRF
check, the pinned deploy with verified backups. None of this needs rebuilding.

## Is progress being made?

On infrastructure, yes: six of the forward plan's eleven steps have been
touched since 2026-08-13, and the stack can be deployed. On the value
hypothesis, no: the two things a pilot depends on are as unproven today as
they were then, and the most recent work (the exact-arithmetic stack, the
250-cell ceiling, the template-shaped upload) moved the ledger path further
from a real user's file rather than closer. The right measure for the next
month is not tests or gates. It is whether one manager's spreadsheet, with a
model choosing the composition, produces a dashboard that manager would keep.
