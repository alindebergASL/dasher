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
Dasher **proposes**, never from what it **honours**. Precisely, and the
precision is the point — an earlier draft of this ADR said a deprecated entry
"stops being reachable by a change instruction", which is one rule too many:

| A deprecated kind                               |         |
| ----------------------------------------------- | ------- |
| Shown in the model prompt                       | **no**  |
| Newly proposed by the deterministic provider    | **no**  |
| Newly **added** by a refinement                 | **no**  |
| Named for **removal** by a refinement           | **yes** |
| Schema-valid, and compiled, in a persisted plan | **yes** |

The fourth row is the one the looser wording got wrong, and the code with it.
Lifecycle filtering ran inside the matcher, before the verb was read, so a
reader looking at a dashboard that still contained a retired section and typing
"Drop the map." was told the instruction was not understood, and the map stayed.
Removing something is not proposing it. Filtering now happens after
classification, in `readRefinementIntent`, and a mixed instruction splits along
the verb rather than the status.

Removal from the schema is a separate, later, breaking change.

There are four places that must honour it, and the first version of this ADR
claimed the rule while shipping two of them. Review caught it: the model prompt
and the refinement matcher filtered, but `FakePlanningProvider` — the provider
this product actually runs — writes its compositions as literals, so every fresh
request would have kept proposing a retired section forever. A lifecycle rule
that governs the model prompt and not the provider in front of readers governs
nothing. The empty-plan fallback named `conditions-summary` as a literal for the
same reason, at the one moment Dasher is choosing entirely for itself.

The filtering points are pure functions over a list (`offeredEntries`,
`matchedSections`, `retainOffered`) and the provider takes its envelope as a
constructor dependency beside its phrasing. Neither is a test seam: what a
planner may propose is configuration, not a fact about the class, and the shipped
registry has nothing deprecated in it, so a rule expressed only as a loop over
the real data would be a rule nothing proves until the first real deprecation —
exactly the wrong moment to find out whether it works.

The second lesson is narrower and worth writing down: testing the pure function
is not testing its **call site**. `retainOffered` had a passing test while the
composer that was supposed to call it could have the call removed with every test
still green. Each filtering point now has a test that drives the provider.

A fourth place had to honour the rule and did not: the empty-plan fallback. Its
comment said a deprecated summary could not become the thing Dasher falls back
to; its implementation ended `?? "conditions-summary"`, so with every
station-free kind retired the literal came back. It now returns nothing, and the
empty plan the contract refuses is the honest answer to "there is nothing left I
am willing to show". **The mutation gate had flagged that exact `?.` as a
survivor, and it was dismissed as an equivalent mutant.** It was not equivalent;
it was the tell. A survivor on a line whose comment makes a promise deserves
reading as evidence about the promise.

`repair` carried a second literal bypass — a synthesised
`["conditions-summary", "gauge-table"]` page — which was also dead: deduplication
keeps the first occurrence of each section, so a schema-valid previous plan
always yields at least one page. Deleted, with the property under test rather
than assumed.

The third came from the mutation gate rather than from reading. A filter on the
composition path must **remove what is retired, not everything it fails to
recognise**. Written as "keep what is offered", `retainOffered` also swallowed
section names that are not in the registry at all — which are not retired, they
are invalid, and the plan schema is what has to refuse them. Two classes of
mutant that the schema used to kill started surviving: a section name replaced
with `""`, and a composition's sections replaced with `[]`. So the filter drops
only known-deprecated kinds, and a page it did not itself empty is left alone.
A safety filter that quietly absorbs bugs is a worse trade than the bug.

## Versioning

Monolithic and semantic. Entries are read together and a plan is valid against
the set, so a per-entry version would describe something no consumer holds.

The rule is subtractive-versus-additive. Stating it any other way contradicts
itself, and the first version of this ADR did: "a kind joins or leaves the
offered set" was MAJOR while "promoted or deprecated" was MINOR, so every
deprecation was both at once.

- **MAJOR** — an entry stops being offered, or a trigger word's meaning changes.
  Both change which plan a request produces, and the first makes a section a
  reader could previously ask for unreachable.
- **MINOR** — a new entry is added, or one is promoted from `experimental` to
  `stable`. Additive: every plan valid before is valid after, the offered set
  only grows, and a promotion changes the promise rather than the behaviour.
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

## What this changed that it should not have

The first version of this slice claimed no behaviour change, on the evidence that
all 200 existing planner tests passed against the rewiring. The evidence was true
and the conclusion was wrong.

Moving the trigger words into the registry changed the order they are matched in
— the private table listed `gauge-table` before `conditions-summary`, the
registry lists them the other way round — and `refine` fills the pages that have
room in the order it receives additions. So "Add the table and summary." against
a nearly-full plan kept the table before and kept the summary after. Two hundred
tests passed either way, because not one of them asked for more sections than
there were slots.

The mistake underneath was conflating two orders. The registry preserved
`PLAN_SECTION_KINDS` order, which is the _schema's_ order; what mattered was the
_matcher's_ order, which lived somewhere else entirely and was never written down.

The fix is not to restore the old order, which was itself arbitrary.
`matchedSections` now sorts by where the reader named each section, so the answer
is a property of what they wrote — named first, served first, which is also the
only rule that can be explained to them. Both directions are tested, so an
implementation that merely picked the other fixed order fails.

What genuinely does not change: every rule the registry states is the rule that
was already being enforced, and the model prompt is the only other visible
difference — it now carries each section's purpose beside its name, on a path
unreachable in the shipped product, which runs the deterministic fake.

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
