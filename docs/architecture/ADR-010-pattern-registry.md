# ADR-010: What Dasher knows about a section lives in one registry

Status: Accepted
Date: 2026-08-21
Prior evidence: `docs/plans/2026-08-20-precedent-library.md` (stage 1)

## Decision

`packages/planner/src/registry.ts` holds one entry per plan section kind. Each
entry states what the section shows, what a planner needs in order to choose it,
which words in a request call for it, whether it needs a station, whether the
compiler may omit it, what contract component it compiles to, and where it is in
its lifecycle. The registry carries a single semantic version.

Four modules now read it instead of holding their own copy of part of it:

| Fact                       | Was                               | Reads the registry |
| -------------------------- | --------------------------------- | ------------------ |
| The closed set of kinds    | `PLAN_SECTION_KINDS` in `plan.ts` | schema, prompt     |
| Which kinds need a station | a private `Set` in `plan.ts`      | `findPlanProblems` |
| Which words name a kind    | `SECTION_WORDS` in `provider.ts`  | `matchedSections`  |
| What a kind is FOR         | nowhere                           | the model prompt   |

`plan.ts` re-exports `PLAN_SECTION_KINDS` and `PlanSectionKind` so no consumer
outside the package changed.

## Why this is an envelope and not a menu

The distinction matters more than the file does. A menu is a list of finished
things to pick from; this is the set of constraints a composition has to satisfy.
Nothing here composes a dashboard, and nothing here is a dashboard. A generator
chooses freely inside the envelope, and a plan that leaves it is refused with a
reason a provider can repair from.

That is Draco's split [A1] with only the hard half built: validity constraints
now, learned soft constraints deferred until there are graded pairs to learn
from. Shipping the hard half alone is the part with standalone value — it is
worth having whether or not the learning bet ever pays.

The registry does **not** reduce how much a planner can invent. It is the same
eight sections that were already the only eight; what changed is that choosing
between them is now informed. The model prompt previously listed eight bare
names, which is a menu with no descriptions — the worst of both.

## Why the guarantee is the test file and not the data file

A registry invites one specific failure: a tidy data file that _describes_ the
compiler, drifts from it, and is believed anyway. That had already happened in
miniature — the private `Set` in `plan.ts` had a comment naming two of its four
exclusions and silently omitting `headline-metrics` and `fastest-rising`, for as
long as the `Set` existed.

So `registry.test.ts` checks every claim by making the product do the thing:

- **`componentKind`** — compile a plan containing only that section and read the
  component that came out.
- **`requiresSites`** — validate a plan with no available station and look for
  the `section_needs_sites` finding.
- **`mayBeOmitted`** — compile against data too thin to draw and see whether the
  section survived.
- **`triggerWords`** — put each word in a change instruction and check the
  refinement matcher reaches that section.

Nine hand-built mutants — a wrong `componentKind`, an inverted `requiresSites`, a
copy-pasted `kind`, a validator that ignores the registry, a prompt that drops
the guidance, a matcher that ignores deprecation, a colliding trigger word — each
fail at least one of these. Draco 2's operating rule is a test per constraint
[A2]; this is that rule with the tests pointed at reality rather than at the
entry.

Writing those tests found a property nobody had stated: a plan whose only section
is the omittable one is **refused**, not rendered empty. The page loses its only
component, the empty page is dropped, and the contract rejects a spec with no
pages — reaching the planner as `spec_rejected`, which is a revision request. It
is the right behaviour and it is now pinned.

## Lifecycle, and the one rule with teeth

`experimental → stable → deprecated`. Deprecation removes a section from what
Dasher **proposes** — it leaves the model prompt and stops being reachable by a
change instruction — while it keeps **compiling**, because plans naming it are
already persisted and a reopened dashboard renders from stored bytes. Removal
from the schema is a separate, later, breaking change.

Both filtering points are pure functions over a list (`offeredEntries`,
`matchedSections`) rather than loops over the module's own registry. That is not
a test seam; it is what makes the rule checkable at all. The shipped registry has
nothing deprecated in it, so a rule expressed only as a loop over the real data
would be a rule nothing proves until the first real deprecation — exactly the
wrong moment to find out whether it works.

## Versioning

Monolithic and semantic. Entries are read together and a plan is valid against
the set, so a per-entry version would describe something no consumer holds.

- **MAJOR** — a kind joins or leaves the offered set, or a trigger word's meaning
  changes. Either can change which plan a request produces.
- **MINOR** — a new entry ships `experimental`, or an entry is promoted or
  deprecated.
- **PATCH** — `summary` or `guidance` wording.

## What is deliberately not in an entry yet

Each of these is in the precedent-library note's stage-1 sketch and is left out
for the same reason: nothing would read it, and a field nothing reads is an
unverified claim sitting next to verified ones.

- **Layout constraints** (shape, spans, placement, density). Nothing in the app
  does layout — the shell renders components in plan order in one column. These
  arrive with packing v1, which is the next slice and their only consumer.
- **Exemplars.** A canonical plan fragment for a single section, in `plan-v1`'s
  vocabulary, _is_ the section's name — sections are a flat enum with no
  parameters. There is nothing for an exemplar to hold until the plan vocabulary
  gains per-section options.
- **Facets.** Orthogonal retrieval vocabulary for the blueprint layer, which does
  not exist. Stage 3.
- **A richer trigger fingerprint** than a word list. What would consume it is a
  real generator, which is the next-but-one slice.
- **`maxPerDashboard`.** Once-per-dashboard is genuinely a global rule today, and
  eight identical fields saying so would be indirection ahead of evidence. The
  first kind that legitimately repeats is what promotes it to an entry field.

## What this does not change

No behaviour, deliberately. All 200 existing planner tests passed against the
rewiring before a single registry test was added, which is the bar: a
consolidation that quietly moved a rule would be worse than not consolidating.
The one visible difference is the model prompt, which now carries each section's
purpose beside its name — and that path is unreachable in the shipped product,
which runs the deterministic fake.

## Where the registry lives

In `@dasher/planner`, next to the four modules that read it, not in a package of
its own. Every consumer today is in that package. A separate package would be the
same code with indirection on top, and the day a second package needs an entry is
the day the move has evidence behind it — the argument `source-runtime.ts`
already makes about a connector framework.

[A1] Moritz et al., "Formalizing Visualization Design Knowledge as Constraints"
(Draco), InfoVis 2018.
[A2] Yang et al., "Draco 2: An Extensible Platform to Model Visualization Design,"
VIS 2023.
