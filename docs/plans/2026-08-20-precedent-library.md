# Precedent Library — Learning to Build Dashboards From Experience

Status: proposal for the design thread · 2026-08-20 · consolidated from four research
rounds (CBR / agent skill libraries / organizational-memory / retrieval & bandits)

## Problem

The harness builds dashboards from a prompt. Today every build starts from the same
state of knowledge: what the planner knows about the seven section kinds
(`summary`, `metric-grid`, `station-map`, `station-table`, `ranking`, `trend-list`,
`alert-list`) and nothing else. Builds accumulate but nothing is retained from them.
We want a knowledge asset that (a) works on day one with zero history, (b) improves
with every build in a workspace, (c) can be inspected, diffed, and rolled back, and
(d) cannot silently make builds worse. Naming: the fixed layer is a **pattern**; the
learned layer is a **blueprint**. Deliberately not called "skills" — these are data
records, not instructions, and must never be confused with the harness's own agent
machinery.

## Two-stage architecture (pattern fixed, blueprint learned)

Strong prior art for the split. CBR separates expert-owned **vocabulary** (hard to
automate, changes rarely) from experience-derived **similarity/adaptation** knowledge
(induced automatically from cases) [1,2]. DSPy freezes the signature — the optimizer
is forbidden from renaming fields — while instructions and few-shot demos under it are
freely optimized, and only successful traces are retained [3]. Generative agents keep
an append-only observation stream and periodically distill reflections that must cite
the records supporting them [4]. Rule: the two layers change at different orders of
magnitude. Patterns amend rarely, via reviewed diff. Blueprints update continuously,
via a distillation job.

**Pattern (semi-fixed):** a section-kind registry entry. Trigger fingerprint (what
prompts it serves), facet vocabulary (sources, density, refresh), guidance, one
canonical exemplar. Version-bound to the schema; a schema change that alters a kind
retires its dependent records. Ships as defaults for all seven kinds so cold-start is
covered.

**Blueprint (learned):** not a whole-dashboard blob. Retrieval works at **section
card** granularity — one card = one exemplar section build with adaptation notes and
facets — and **composition records** capture which cards composed into which kept
dashboard. Rationale: whole-case retrieval collapses combinatorially (medical
multi-disorder CBR: whole-case retrieval solved 3% of cases; compositional retrieval
solved 72–83%) while decomposed retrieval keeps distances short and coverage dense
[5,6]. Dashboards are arrangements of sections; the arrangement space is exactly where
whole-case retrieval dies.

## Retrieval: structured-first hybrid

Dasher prompts are short and the corpus is facet-rich — the regime where pure dense
embeddings are weakest and lexical/dense fail orthogonally [7]. Pipeline: hard facet
pre-filter (section kind, source types, schema version) → BM25 + dense with reciprocal
rank fusion → assemble. Embeddings are one signal, not the index. HyST shows
LLM-extracted structured filters + semantic ranking beat pure-semantic baselines on
semi-structured corpora [8].

## Selection: abstain first, then explore on purpose

- **Abstention gate.** If hybrid retrieval confidence is low (novel prompt, no facet
  match), do not force a precedent — build from the pattern defaults and log the
  prompt as a new-pattern candidate. Selective-prediction theory: forcing predictions
  when the likelihood ratio favors "retrieval will mislead" is the dominant error
  [9,10]. Abstention clusters become the demand map for pattern-registry expansion —
  the registry grows from observed need, not imagination.
- **Thompson sampling over top-k candidates.** Sample from each candidate's
  keep-rate posterior rather than taking the argmax. New cards are explored
  automatically and exploration decays as posteriors concentrate; hierarchical priors
  from the parent pattern solve cold-start; and exploration doubles as an anti-collapse
  diversity mechanism [11].

## Learning loop

1. **Telemetry (always on):** proposal, user edits with edit-distance, outcome.
2. **Anchor-aware weighting:** a kept build proves "acceptable given the anchor," not
   "best" — herding bias [12]. Zero-edit keeps count least; edits-then-keeps count
   most. Old observations are discounted (non-stationary bandits) so stale blueprints
   decay rather than entrench.
3. **Distillation (periodic, reviewed):** reflection-style — insights must cite the
   records that support them [4] — shipped as reviewable, revertible diffs.
4. **Provenance tiers (anti-collapse):** human-edited finals are ground truth;
   unedited AI builds are second-class with a capped corpus share; generation depth is
   tracked and never allowed to dominate — recursive training on model-generated data
   collapses the distribution [13]. ADR-008's tiers are the natural home.
5. **Maintenance:** coverage, not volume. Cards earn their place by reuse + keep-rate;
   compositional footprinting — a card that only matters *in combination* still earns
   retention [14]. The utility problem is proven: past a critical size, every addition
   makes retrieval slower and worse [1,15]. Lessons-learned systems die of vague
   entries, capture-as-ritual, and no evidence a lesson changed a decision [16,17].

## The flywheel, honestly

Four gates must all hold: strong signal (edit telemetry, not clicks), conversion (the
library is the asset — no fine-tuning), perceivable improvement, and loop closure
[18]. Within-workspace learning is the version consistent with the no-surveillance
posture and the defensible one ("your dashboards teach your workspace"). Falsifiable
check: pattern-on vs pattern-off A/B on keep-rate and edit-distance. If the delta is
not user-perceivable, the flywheel is a data-collection program, not a moat.

## Explicitly not doing

Fine-tuning. Whole-dashboard retrieval as the primary unit. Auto-rewriting pattern
triggers. Cross-workspace data pooling. Distilling from distilled output.

## Open questions for the thread

1. Where do section cards live — repo (versioned with code) vs database (per-workspace)?
   Hybrid: patterns in repo, cards+records in DB?
2. Is keep-rate the right primary metric, or a blend with edit-distance?
3. When does the abstention threshold get tuned — against what ground truth?
4. Does composition-record retrieval need its own index, or is facet filter over cards
   enough for v0?

## References

[1] Richter, Aamodt — knowledge containers; vocabulary learning resists automation.
[2] Sarathy & Krishnan, IJCAI 2018 — quantifying knowledge tradeoffs between containers.
[3] DSPy signatures & optimizers — frozen interface, learned parameters. dspy.ai.
[4] Park et al., UIST 2023 — Generative Agents: memory stream + cited reflections.
[5] Wilke & Bergmann lineage; multiple-CBR medical system — compositional vs naive retrieval.
[6] Case representation survey (IJACSA 2015) — decomposed sub-cases, shorter retrieval distance.
[7] tianpan.co hybrid-retrieval decision framework (2026) — lexical/dense orthogonality.
[8] HyST, arXiv 2508.18048 — LLM-extracted filters + dense rank beat semantic-only.
[9] Plugin estimators for SCOD, ICLR 2024 — unified abstention theory.
[10] Calibrated selective classification, arXiv 2208.12084 — abstain on uncertain uncertainty.
[11] Thompson sampling w/ hierarchical priors & in-slate diversity, DMKD 2022 (FINN.no).
[12] TS-Conf, arXiv 2408.14432 — herding/conformity bias in feedback.
[13] Shumailov et al., Nature 631 (2024) — model collapse under recursive training.
[14] FootprintCA, IJCAI 2017 — compositional case-base maintenance.
[15] Utility problem in CBR — ever-growing case bases degrade retrieval.
[16] NASA OIG IG-12-012 — lessons-learned system failure modes.
[17] BMC Health Serv Res 2026 — organizational forgetting; retention needs monitoring.
[18] Institute of PM — AI network effects: the four flywheel gates.
