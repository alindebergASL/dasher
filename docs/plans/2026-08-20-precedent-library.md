# Precedent Library — Learning to Build Dashboards From Experience

Status: proposal for the design thread · v3 · 2026-08-20

v1 consolidated four research rounds (CBR, agent skill libraries, organizational
memory, retrieval & bandits). v2 adds a citation-verification pass and three further
sweeps — visualization recommendation & design-systems practice, agent memory and
skill induction 2023–2026, and feedback metrics & small-n experimentation — roughly
sixty primary sources checked, every load-bearing number below traced to a named one.
The architecture survived the pass. The primary precedent, the metric, and the
selection machinery did not, and this revision records what replaced them and why.
v3 adds a fourth sweep — decision science, BI adoption empirics, trusted learning
products, and engineered precedent systems (citators, ASRS, clinical guidelines) —
answering the question v2 left implicit: what this library is _for_ [H-sections].

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

## Who consumes this — the question v1 never asked

Retrieval feeds a generator, and Dasher's product generator is **deterministic**: the
planner runs with no model calls, and a repository test enforces that. This decides
the record format before anything else does. An LLM consumer can eat loose prose
exemplars; a deterministic planner needs **typed, parseable plan fragments** it can
validate and execute. The skill-library literature points the same way: the retained
artifacts that transfer are validated, executable or schema-constrained ones —
Voyager's verified code skills [B4], AutoManual's managed typed rules [B6], CLIN's
fixed-schema causal entries [B5] — not free text.

So: a **section card is a typed plan fragment** (the plan vocabulary ADR-007 already
keeps), plus facets and provenance, checked by the same contract machinery as
everything else. LLM consumption becomes a later _mode_ of the same records, not a
different design. This also collapses what v1 treated as new invention: the
`DashboardPlan` is already a composition-only arrangement record, re-parsed on every
round trip — the blueprint layer extends it rather than inventing a third vocabulary.

## Two-stage architecture (pattern fixed, blueprint learned)

The split now has a flagship precedent in this exact domain. **Draco** [A1] formalizes
visualization design knowledge as hard constraints (validity) plus soft constraints
whose weights are learned — learned weights reached 93% ranking accuracy where
hand-tuned weights managed 65%, "only slightly better than chance." **Draco 2** [A2]
then documents how such a knowledge base is operated: a unit test per constraint,
documentation co-located with each entry, weights in a separate data file from the
rules, semantic-versioned releases, behavioral regression suites across versions.
DSPy's frozen-I/O-contract-with-learned-parameters [B1] and Generative Agents'
cited reflections [B2] remain supporting precedent (both characterizations were
verified against the papers). Rule: the two layers change at different orders of
magnitude — patterns amend rarely, via reviewed diff; blueprints update continuously,
via a graded pipeline.

**Pattern (semi-fixed):** a section-kind registry entry. Trigger fingerprint, facet
vocabulary, guidance, one canonical exemplar, **layout constraints** (see below), and
a lifecycle status. Version-bound to the schema; a schema change that alters a kind
retires its dependent records. Ships as defaults for all seven kinds so cold-start is
covered — and the enrollment dashboard already exercises a subset of the same kinds,
so the defaults cover the non-sensor shape too.

**Blueprint (learned):** not a whole-dashboard blob. Retrieval works at **section
card** granularity, with **composition records** as a first-class peer — not an
afterthought, because the published quality functions for dashboards are mostly
_between_ sections: diversity and parsimony rewards (best dashboards carry 3–5
charts) [A4], pairwise arrangement rules [A6], sequence-level scoring [A5]. A card
index alone cannot express "don't ship three trend-lists."

The granularity evidence, corrected and strengthened. The medical multi-disorder
result v1 cited is real — Atzmueller, Baumeister, Puppe, Shi & Barnden, FLAIRS 2004
[C1], on 744 sonography cases averaging 6.7 diagnoses each: whole-case retrieval
solved **3%**; decompose-retrieve-recombine solved **67–84% depending on strategy**
(72% for pure compositional adaptation; v1's "72–83%" appears in no version of the
work). Their combinatorics is our combinatorics: "the chance of reusing a case with
even 3 independent diagnoses from say 100 alternatives is roughly just one to one
million." Two details transfer directly. The best strategy (84%) leaned on
expert-provided _partition_ knowledge — which for dashboards is the fixed section
taxonomy we already have. And independently, Agent Workflow Memory [B3] induces
sub-task workflows from successful trajectories with instance values abstracted to
slots, improving WebArena success 23.5%→35.5% and beating _expert-written_ workflows
— sub-task granularity, success-gated admission, slot abstraction: the section-card
design, validated at ICML.

One hard boundary the cards must respect: composition of multi-source dashboards
happens at the level of finished per-domain specs (arrangement without computation),
so `domain` is a **hard pre-filter facet**, and composition records for combined
dashboards record the _pair at dashboard level_ — never interleaved cross-domain
sections the pipeline cannot and should not build.

## One instrument, three jobs: persist refinement edits

Three findings from three different literatures converge on a single product change.
Today refinement edits are discarded — only fresh generations get durable identity.
Persisting the edit trail (proposed plan → settled plan, with the diff) provides:

1. **The primary metric.** Keep-rate as v1 defined it is degenerate here: every
   successful build auto-persists, there is no discard event, so recorded keep-rate
   is ~1.0 by construction. Industry converged on **retention-after-edit** — GitHub
   moved from acceptance rate to "accepted and retained characters" after finding
   acceptance-rate focus "can lead to experiences that look good on paper" [D1,D2];
   Meta treats acceptance as a usage metric, not a quality metric [D3]. The dashboard
   analogue is a normalized **tree edit distance over the spec** (the TSED family
   [D4]) between the proposed build and the version the user settles on —
   deterministic, computable at n = 1.
2. **The failure signal.** The current frontier learns from failures, not only
   successes: GEPA outperforms MIPROv2 by over 10% by reflecting on failed attempts
   [B7]; ExpeL's strongest signal is fail/success contrast pairs [B8]; CLIN stores
   explicit negative knowledge [B5]. A keeps-only corpus discards the most
   informative data the literature has found. Edit deltas are that record.
3. **The adaptation knowledge.** v1 attached free-text "adaptation notes" to cards —
   the one mechanism the verification pass found _no_ precedent for. Adaptation
   knowledge acquisition is CBR's documented thirty-year bottleneck [C2], and the
   field's remedy is inducing it from **differences between case pairs** [C3], never
   hand-written prose. An edit pair _is_ a case-pair difference. Notes become
   optional annotation; the edit diff is the adaptation container.

## Why this is Dasher, not a feature

The requirements doc's thesis — "a governed decision loop that turns a bounded
plain-language intent and authorized evidence into a safe managerial action and
**durable decision memory**" — makes the precedent library the second half of that
sentence, operationalized. The one-instrument schema change _is_ the decision-memory
clause. What the fourth research sweep adds is that each remaining clause of the
loop corrects a specific, measured failure of unaugmented judgment:

- **Bind intent** corrects framing: identical outcomes framed as gains vs losses
  reversed preferences 72% vs 22% of respondents [H1].
- **Answers first** matches how executives actually read: BLUF documents were read
  17–23% faster with better comprehension by 262 naval officers [H2].
- **Epistemic typing + durable memory** is the calibration mechanism: the
  tournament literature's largest measured judgment improvement came from
  record-decision → score-outcome → feedback loops (GJP forecasters reached
  near-perfect calibration, 0.01 overconfidence, by making finer-grained
  distinctions between what they knew and what they were judging) [H3]; and
  reconstructing "what was known and why" is the only documented correction for
  hindsight and outcome bias, the two best-replicated biases in the review
  literature [H4]. ADR-005's success criterion — "later reconstruct what was known
  and why — not merely when a dashboard renders" — is, read this way, an
  anti-hindsight instrument.
- **Propose, never act** is the comfortable side of the personalization evidence:
  trust damage from personalization is driven by _unexpected_ inference, and
  aggregate-level signals ("your team's kept dashboards") are consistently more
  comfortable than individual-level ones ("users like you") [H5]. The library's
  only visible surface — one row in "Why Dasher says this" — is attributional,
  aggregate, and on-demand, which is the trusted shape on every axis measured.

The market framing follows from the same sweep, and is held more loosely than
everything above it. Industry analysis reports that BI hands-on use has plateaued
at roughly a quarter to a third of the workforce, with the large majority of
enterprise decision-makers consuming _mediated_ evidence rather than using tools
directly [H6-industry]; the peer-reviewed adjacent literature establishes the
weaker but firmer claim that data-driven decision practice is unevenly adopted
and management-practice bound [H6-reviewed]. The specific ~80% figure is
analyst-sourced and not independently verified here, so no design decision in
this note rests on it. What does the work is the thesis itself: a plain-language
request that yields an inspectable, epistemically-typed proposal is an interface
for people who currently receive evidence secondhand, whatever their exact share.
The library compounds that position without widening authority — the flywheel
turns within one workspace, which is both the no-surveillance posture and the
vertical-specific, defensible form of the data advantage [H7-commentary].

## Retrieval: structured-first, and honest about scale

Pipeline: hard facet pre-filter (domain, section kind, source types, schema version)
→ BM25 → assemble. Retrieved-over-random is one of the most robust findings for
structured generation — random example selection scored 1.7 vs 26.0 exact-match for
plain untrained BM25 on semantic parsing [C4] — but those gains were measured on
pools three to four orders of magnitude larger than ours, and at dozens of cards
there is no published winner between lexical and dense. Dense embeddings are also a
model call, which the product's no-model posture forbids; conveniently, the evidence
does not currently demand them (BM25 is the strong zero-shot baseline out of domain
[C5], and dense retrieval's failure mode grows with index size, not against small
ones [C6]). v0 is facets + BM25, held loosely, with dense revisited only behind a
deliberate policy change _and_ measured BM25 misses.

Two stability requirements from the recommendation literature ride along. Retrieval
is **anchored**: when re-planning after a prompt edit, candidates near the
workspace's existing dashboard are preferred, or users experience blueprint churn on
every small change [A7]. And candidate sets carry **deliberate diversity**: example
retrieval measurably causes design fixation [A8], and diversity alone lifted
engagement in the one production Thompson-sampling deployment v1 cited [E1].

## Selection: abstain by rule, explore later

- **Abstention gate, as a rule — not a calibrated probability.** Risk-calibrated
  thresholds require labeled outcomes we do not have [E2]. Production practice ships
  a constant or a rule: Rasa and Dialogflow default a confidence floor of 0.3 to a
  fallback intent; Amazon Personalize backfills with popularity defaults when data
  is insufficient [E3]. Ours: _fewer than k prior builds match this prompt shape →
  build from registry defaults_, revised by inspecting logged misses. Internal
  precedent: `classifyRequest` already abstains rather than guesses. Abstention
  clusters remain the demand map for registry expansion.
- **No bandit yet, and the arithmetic is the reason.** Separating a 50% vs 60%
  outcome rate needs ~388 observations per arm [E4]; at 24 per arm only a jump to
  ~87% is detectable; discounting with γ = 0.95 caps effective memory at ~20
  observations [E5]; a one-workspace "hierarchical prior" is a hand-written prior
  [E6]. Worse, adaptively collected data degrades the very falsification test this
  note proposes — Thompson-sampled allocation can double both false positive and
  false negative rates in later analysis [E7], and bandit traffic splits reduce test
  power at equal n [E8]. Selection machinery and measurement compete for the same
  scarce observations; at this scale we choose measurement.

## Learning loop

1. **Telemetry first** (the true first slice): persist refinements with durable
   identity; add keep/discard events; log retrieval scores and any randomization
   server-side — the prerequisites for ever tuning anything offline [E9].
2. **Eval corpus as the primary loop.** At near-zero traffic this is not a
   compromise; it is the documented mainstream. DSPy's entire paradigm is
   optimization against a versioned, metric-graded corpus — candidate demonstrations
   are admitted only when they pass the metric, and there is no production-traffic
   mode in the framework [B1]; Learn-by-Interact grows exemplar libraries
   synthetically and offline, then quality-filters [B9]. Concretely: versioned
   prompt → kept-plan pairs, graded by the existing eval harness; falsified plans
   become cases — formalizing what this project already does. Production telemetry
   joins later as a **higher-provenance tier** of the same corpus.
3. **Falsification by pairing, not A/B.** A pattern-on/off A/B on a binary outcome
   is unrunnable at n = dozens (detectable effect: near-total success or failure)
   [E4]. The design with published sensitivity at tiny n is within-subject pairing:
   interleaving reached 95% power with >100× fewer subjects than the most sensitive
   A/B metric at Netflix, 50× at Airbnb [E10]; medicine's population-of-one answer
   is the randomized ABAB crossover [E11]. Ours: generate registry-only and
   registry-plus-precedent plans for the _same prompt_, randomized order, and score
   which the user settles nearer to by spec edit distance. The flywheel test keeps
   v1's sentence with a test that can actually run: **if paired edit distance shows
   no user-perceivable difference, the precedent layer is a data-collection
   program, not a moat.** Caveat carried with it: offline similarity does not
   predict outcome value — measured correlation at Booking.com across 23 model
   comparisons was −0.1 [E12] — so retrieval confidence is never reported as
   expected quality.
4. **Anchor-aware weighting** stands: zero-edit keeps count least (herding [E13]);
   edited-then-kept counts most — now _measurable_, because the edits persist.
5. **Maintenance stays dormant until saturation**, and when it wakes it must be
   composition-aware: classic competence-based footprint deletion provably fails
   under compositional adaptation — a card that only matters _in combination_ still
   earns retention [C7]. At dozens of builds, deletion earns nothing [C8].

## Corpus integrity: two invariants, not a cap

v1 proposed a capped corpus share for AI-generated records. Read precisely, the
collapse literature supports two invariants instead: **accumulate, never replace**
— retaining the original data alongside synthetic bounds the damage, and replacing
it is what collapses [F1,F2] — and **keep fresh human-validated cases flowing in**
[F3]. Implementation pattern: contradicted or superseded records are _invalidated,
never deleted_, with source links preserved [B10]; records that evolve do so
copy-on-write (in-place mutation is the documented anti-pattern [B11]). The
provenance **tiers** themselves — human-edited finals outranking unedited AI
builds, generation depth tracked — appear in _no_ surveyed system, research or
production. They stay in this design as an original contribution, stated as such,
with ADR-008 as their home and their validation as open work. Honest caveat: the
collapse results concern training generative models on their own outputs; a
retrieval corpus degrades differently, so the analogy motivates the invariants
rather than proving them.

## Registry governance — the part "expert-owned" left implicit

From Draco 2 [A2] and design-systems practice, the operating manual:

- A test and co-located documentation per registry entry.
- **Lifecycle status** on every entry and facet value — experimental → stable →
  deprecated — with promotion checklists and removal bound to the next schema major
  (Shopify Polaris; IBM Carbon) [G1].
- **SemVer, monolithic**: one version stamps the registry; breaking = trigger
  fingerprint or facet semantics; patch = guidance or exemplar wording [G2].
- Serialization copies the design-tokens shape: description and `$deprecated`
  inline per entry; the registry file itself version-stamped [G3].
- Facets orthogonal and semantic, named centrally (Figma variant practice) [G4].
- **Adoption telemetry from day one**: per-kind insertion counts plus the _detach_
  analogue — a user deleting or heavily overriding a planned section — which is the
  canonical "component didn't fit" signal feeding deprecation decisions [G4].
- A **"why this plan" trace** before the registry or facet vocabulary grows:
  constraint knowledge bases outgrow their maintainers' ability to retrace
  decisions [A9].

## Interaction consequences — where the loop meets a person

The fourth sweep also located the interaction seams where the loop's promise
strains, all verified against the current code:

- **"Live" has three meanings and they do not agree.** The example prompt invites
  "a live dashboard" (`planning.ts:20`, and the placeholder and chip beside it);
  the shell badges `dataMode === "live"` (`dashboard-shell.tsx:485`); but every
  builder hardcodes `dataMode: "demo"` (`compile.ts:373`,
  `ucr-campus-facts.ts:188`, and `compose.ts:399` inheriting from its sources), so
  the live badge is currently **unreachable** — a genuinely live-sourced build
  still reads "Demo." `sourceMode()` never reaches `dataMode`. The badge therefore
  carries no information today. Wire them, and add a third state for sealed
  artifacts: a reopened dashboard renders build-time bytes with no refresh path, so
  it is a snapshot regardless of how its data was fetched. (Alert-adjacent honesty:
  clinical systems reach 90%+ alert override once volume erodes scarcity [H8] —
  "Needs attention" is a trust asset only while it stays scarce.)
- **Refinements are the product's soul and its data loss.** Refinement edits shape
  the on-screen dashboard but only fresh generations get durable identity
  (`actions.ts:127`). The user who refines to perfection, leaves, and returns from
  the listing finds their edits gone. The one-instrument change (stage 3) closes
  this; until then the on-screen divergence should at least be labeled.
- **No undo.** There is no revert or history surface anywhere in the app;
  conversational editing is currently one-way. A session-scoped undo stack is the
  cheap interim.
- **The refinement wall on combined dashboards.** `planning.ts` honestly records
  why two-plan dashboards have no refinement path; #39 made multi-source the growth
  direction, so the newest capability creates the dashboards where the best
  interaction is missing. Scoped refinement ("on the river half, drop the map") is
  the in-vocabulary design answer.
- **Abstention needs a graceful surface.** The request path needs the same dignity
  the refinement path already has ("did not understand that change" instead of
  redrawing): a novel prompt the library cannot serve should produce the honest
  nearest-true-thing, not a blank or a shrug.
- **Learning must never move furniture.** Adaptation shapes proposals only; nothing
  the user placed changes without instruction (the adaptive-vs-adaptable
  distinction, and the reviewable-diff rule for registry growth) [H9].

## Layout lives here too

The queued packing thread converges on the same artifact. No published system
learns dashboard layout from user feedback; the corpus-mining work (854 dashboards)
produced a small set of _readable per-component-type rules_ [A6], and shipping BI
practice is uniformly deterministic — fixed-column grids with per-widget-type
default spans and gravity compaction [G5]. So each registry entry carries its
kind's **layout constraints** (shape, min/preferred spans, placement tendency,
density class), packing v1 is a deterministic grid over those rules against the
three real shapes, and the page-layout pattern vocabulary [A10] becomes a facet on
composition records — layout intent recorded as future training exhaust, no learned
model.

## Staging

1. **Pattern registry** — all seven kinds; fingerprint, facets, guidance, exemplar,
   layout constraints, lifecycle; Draco-2-style governance. Standalone value
   regardless of the learning bet. Patterns live in the repo.
2. **Packing v1** — deterministic grid + per-kind rules, against river, enrollment,
   and combined river+air.
3. **Telemetry** — persist refinements; keep/discard events; server-side logs with
   retrieval scores; the spec edit-distance metric. Cards and records live in
   Postgres under the same per-organization row security as dashboards — which
   turns "no cross-workspace pooling" from a policy promise into the enforcement
   mechanism the persistence tests already prove.
4. **Eval corpus** — versioned prompt → kept-plan pairs graded by the harness;
   paired registry-only vs registry-plus-precedent falsification as the standing
   honesty test.
5. **Dormant machinery, by trigger** — facet+BM25 retrieval consumed by the
   deterministic planner _when the corpus reaches ~50 cards_; bandit selection
   _at ≥100 outcome observations per candidate arm_; preference-weight learning
   _at ≥250 graded pairs_ (Draco's measured floor [A1]); dense retrieval _only
   after a model-call policy change and measured BM25 misses_; pruning _only at
   saturation, composition-aware_ [C7].

## Explicitly not doing

Fine-tuning. Whole-dashboard retrieval as the primary unit. Auto-rewriting pattern
triggers. Cross-workspace data pooling. Distilling from distilled output. Free-text
adaptation notes as a required field. Bandit selection before its trigger. Dense
retrieval under the no-model posture. Cross-domain section interleaving.

## Questions v1 left open — answered or dissolved

1. _Where do cards live?_ Hybrid, decided: patterns in the repo (versioned with the
   schema, like the contract); cards and composition records in Postgres under
   organization-scoped row security (stage 3).
2. _Is keep-rate the right primary metric?_ No — it is unmeasurable here (no
   negative class) and the industry that had it retired it. Spec tree edit distance
   between proposed and settled builds, with keep/discard events added for the
   coarse signal.
3. _When does the abstention threshold get tuned, against what ground truth?_ Not at
   design time. Ship a rule with a constant; revise from logged misses; a learned
   calibrator only once (retrieval features → outcome) pairs exist to train it on
   [E2].
4. _Does composition-record retrieval need its own index for v0?_ No — facet filter
   over a corpus of dozens; revisit when facet-sparsity abstentions say otherwise.

## What remains genuinely open

- **Whether the learned layer pays at all.** Hand-designed knowledge won its only
  direct match at this corpus scale — DashBot's expert rewards were preferred over
  MultiVision's learned scoring, trained on millions of pairs, on 78% of ratings
  [A4,A5] — and Draco's weight learning has a measured ~250-pair floor. The paired
  test exists to answer this honestly; the design should survive either answer.
- **Provenance-tier validation.** First system to run authorship-tiered retrieval
  memory; no precedent to lean on.
- **The event schema's edges.** What counts as "discard" in a product with no
  delete; how a reopened-months-later dashboard scores.
- **Failure-response arithmetic.** The citator model's leverage is graded doubt:
  accumulated weak-negative treatment moved the probability of strong negative
  treatment from 0.5% to 80.2% in the legal corpus [H10]. Dasher's analog — how
  many soft contradictions (edits away from a card) before a card loses retrieval
  standing — has no measured answer; ship a conservative rule and revise from
  logged outcomes, exactly as the abstention rule is.
- **Learning-rate realism.** The library can learn only from deviation. Kept-vs-
  edited distillation is exploitation; the competence trap is "effective in the
  short run but self-destructive in the long run" [H11]. Abstention clusters must
  actually feed registry expansion, or the learning stalls. Double-loop moments —
  recurring abstention patterns questioning the taxonomy itself — should be
  scheduled, not spontaneous [H12].

## References

Peer-reviewed:
[A1] Moritz et al., "Formalizing Visualization Design Knowledge as Constraints"
(Draco), InfoVis 2018, Best Paper.
[A2] Yang et al., "Draco 2: An Extensible Platform to Model Visualization Design,"
IEEE VIS 2023.
[A4] Deng et al., "DashBot: Insight-Driven Dashboard Generation Based on Deep
Reinforcement Learning," IEEE VIS 2022.
[A5] Wu et al., "MultiVision: Designing Analytical Dashboards with Deep Learning
Based Recommendation," IEEE VIS 2021.
[A6] Lin et al., "DMiner: Dashboard Design Mining and Recommendation," IEEE TVCG 2023.
[A7] Lin, Moritz, Heer, "Dziban: Balancing Agency & Automation in Visualization
Design via Anchored Recommendations," CHI 2020.
[A8] Bako et al., "Unveiling How Examples Shape Visualization Design Outcomes,"
IEEE VIS 2024.
[A9] Schmidt et al., "Visual Analytics for Understanding Draco's Knowledge Base,"
IEEE VIS 2023.
[A10] Bach et al., "Dashboard Design Patterns," IEEE VIS 2022.
[B1] Khattab et al., "DSPy: Compiling Declarative Language Model Calls into
Self-Improving Pipelines," ICLR 2024; Opsahl-Ong et al. (MIPRO), EMNLP 2024.
[B2] Park et al., "Generative Agents," UIST 2023.
[B3] Wang et al., "Agent Workflow Memory," ICML 2025.
[B4] Wang et al., "Voyager: An Open-Ended Embodied Agent with Large Language
Models," TMLR 2024.
[B5] Majumder et al., "CLIN: A Continually Learning Language Agent," COLM 2024.
[B6] Chen et al., "AutoManual," NeurIPS 2024.
[B7] Agrawal et al., "GEPA: Reflective Prompt Evolution Can Outperform
Reinforcement Learning," ICLR 2026.
[B8] Zhao et al., "ExpeL: LLM Agents Are Experiential Learners," AAAI 2024.
[B9] Su et al., "Learn-by-Interact," ICLR 2025.
[C1] Atzmueller, Baumeister, Puppe, Shi, Barnden, "Case-Based Approaches for
Diagnosing Multiple Disorders," FLAIRS 2004 (with GWEM 2003 companion).
[C2] Hanney & Keane, "The Adaptation Knowledge Bottleneck," ICCBR 1997; Richter's
knowledge containers, LNAI 1400, 1998.
[C3] Craw, Wiratunga, Rowe, "Learning adaptation knowledge to improve case-based
reasoning," Artificial Intelligence 170, 2006.
[C4] Rubin, Herzig, Berant, "Learning To Retrieve Prompts for In-Context Learning"
(EPR), NAACL 2022; Liu et al. (KATE), DeeLIO 2022.
[C5] Thakur et al., "BEIR," NeurIPS 2021 D&B.
[C6] Reimers & Gurevych, "The Curse of Dense Low-Dimensional Information Retrieval
for Large Index Sizes," ACL 2021.
[C7] Mathew & Chakraborti, "Competence Guided Model for Casebase Maintenance,"
IJCAI 2017 (footprintCA; from ICCBR 2016).
[C8] Smyth & Keane, "Remembering To Forget," IJCAI 1995; Smyth & McKenna,
"Footprint-Based Retrieval," ICCBR 1999.
[D3] Murali et al., "AI-assisted Code Authoring at Scale" (CodeCompose), ESEC/FSE 2023.
[D4] Song et al., "Revisiting Code Similarity Evaluation with Abstract Syntax Tree
Edit Distance," ACL 2024.
[E1] Eide, Leslie, Frigessi, "Dynamic slate recommendation with gated recurrent
units and Thompson sampling," DMKD 2022 (FINN.no).
[E2] Geifman & El-Yaniv, "Selective Classification for Deep Neural Networks,"
NeurIPS 2017; Kamath, Jia, Liang, ACL 2020.
[E4] Lai & Robbins, Adv. Appl. Math. 1985; Kohavi et al., DMKD 2009 (n = 16σ²/Δ²);
Kohavi, Tang, Xu, "Trustworthy Online Controlled Experiments," CUP 2020.
[E5] Garivier & Moulines, "On Upper-Confidence Bound Policies for Non-Stationary
Bandit Problems," ALT 2011.
[E6] Hong et al., "Hierarchical Bayesian Bandits," AISTATS 2022.
[E7] Williams et al., "Challenges in Statistical Analysis of Data Collected by a
Bandit Algorithm," arXiv:2103.12198.
[E8] Xiang et al., "Multi Armed Bandit vs. A/B Tests in E-commerce," KDD 2022.
[E9] Li, Chu, Langford, Wang, "Unbiased Offline Evaluation of Contextual-bandit-
based News Article Recommendation Algorithms," WSDM 2011.
[E10] Chapelle, Joachims, Radlinski, Yue, ACM TOIS 2012; Zhang et al. (Airbnb),
KDD 2025.
[E11] Lillie et al., "The n-of-1 clinical trial," Personalized Medicine 2011.
[E12] Bernardi, Mavridis, Estevez, "150 Successful Machine Learning Models: 6
Lessons Learned at Booking.com," KDD 2019.
[E13] Xu et al. (TS-Conf), "Contextual Bandit with Herding Effects," PRICAI 2024.
[F1] Shumailov et al., "AI models collapse when trained on recursively generated
data," Nature 631, 2024.
[F2] Gerstgrasser et al., "Is Model Collapse Inevitable? Breaking the Curse of
Recursion by Accumulating Real and Synthetic Data," COLM 2024.
[F3] Alemohammad et al., "Self-Consuming Generative Models Go MAD," ICLR 2024.
[D1] Ziegler et al., "Productivity Assessment of Neural Code Completion," MAPS
2022 / CACM 2024 (acceptance and survival metrics; ρ = 0.24 at thousands of users).

Industrial practice:
[D2] GitHub Engineering, "The road to better completions," 2025 ("accepted and
retained characters" as north star).
[E3] Rasa fallback and Dialogflow intent-matching documentation; Amazon Personalize
recommendations documentation.
[G1] Shopify Polaris component lifecycle; IBM Carbon component status checklists.
[G2] Curtis, "Versioning Design Systems," EightShapes.
[G3] W3C Design Tokens Community Group specification (2025.10; `$deprecated`).
[G4] Figma variants best practices; Figma Library Analytics (insertions,
detachments).
[G5] Grafana layout schema (24-column grid, gravity); Apache Superset /
react-grid-layout; Tableau tiled containers; Power BI snap-to-grid.
[B10] Rasmussen et al., "Zep: A Temporal Knowledge Graph Architecture for Agent
Memory," arXiv 2025 (invalidation-not-deletion; vendor benchmarks disputed).
[B11] Xu et al., "A-MEM: Agentic Memory for LLM Agents," NeurIPS 2025 (in-place
evolution — cited here as the anti-pattern).

Dropped from v1: the hybrid-retrieval decision framework and AI-flywheel commentary
references (blog-tier, superseded by [C4–C6] and [E4–E12]); HyST (arXiv 2508.18048)
demoted from load-bearing to motivational — it verifies, but it is an unreviewed
preprint with a 76-query single-benchmark evaluation.

Fourth sweep (v3) — decision science, BI empirics, trusted learning, engineered
precedent systems. Tiered, as the rest of this list is: [H6-industry] and [H7-commentary] are analyst
and practitioner material carrying the market framing, and are marked in-text so a
reader can see which claims rest on peer review and which do not.

Peer-reviewed:

[H1] Tversky & Kahneman, "The Framing of Decisions and the Psychology of Choice,"
Science 211 (1981).
[H2] Suchan & Colucci, "An Empirical Study of Military Communications: BLUF vs.
Bottom-Up," IEEE Trans. Professional Communication 32(1) (1989); n = 262.
[H3] Mellers, Ungar, Baron et al., "Psychological Strategies for Winning a
Geopolitical Forecasting Tournament," Psychological Science 25(5) (2014);
Tetlock, Mellers, Rohrbaugh, Chen, "Forecasting Tournaments," (2017);
Chang, Chen, Mellers, Tetlock, "The Henry Alexander Murray Lecture: Study and
Improving Expert Political Judgment with the HITCH," (2016). Calibration and
training effect sizes from the GJP/IARPA program.
[H4] Fischhoff, "Hindsight ≠ Foresight: The Effect of Outcome Knowledge on
Judgment Under Uncertainty," JPSP 1975; Baron & Hershey, "Outcome Bias in
Decision Evaluation," JPSP 1988; Guilbault, Bryant, Brockway & Posavac,
"A Meta-Analysis of Research on Hindsight Bias," Basic & Applied Social
Psychology 26 (2004).
[H5] Ur, Page, Kiesler et al., "Do Dark Patterns & Personalization coincide?
An Analysis of Creepiness, Agency & Situational Awareness," CHI 2018 (n = 401);
Zhan, Trewin et al., "Relationship between AI-Mindfulness and Trust in
AI-Enabled Services," CHI 2025 (n = 450; intermediate autonomy flattens the
personalization-trust damage).
[H6-reviewed] Brynjolfsson & McElheran, "Data in Action: Data-Driven Decision
Making in US Manufacturing," SSRN 2016; Bloom & Van Reenen, "Measuring and
Explaining Management Practices Across Firms and Countries," QJE 122(1) (2007).
These establish uneven adoption of data-driven practice; they do not report the
~80% mediated-consumption figure.

[H8] Nanji, Slight, Seger et al., "Overrides of Medication-Related Clinical
Decision Support Alerts in Outpatients," JAMIA 21(3) (2014; 49–96% override
prevalence across studies, pooled estimates near 90% for high-severity drug-
interaction alerts); van der Sijs et al., "Overriding of Drug Safety Alerts in
Computerized Physician Order Entry," JAMIA 13(2) (2006).
[H9] Findlater & McGrenere, "Impact of User Goals on Customizable UI Usage,"
CHI 2004 (mixed-initiative vs. pure adaptive); Kay, "Scrutable Adaptation:
Because We Can and Must," UMAP 2006 (invited).
[H10] Spriggs & Hansford, "The Malleability of Legal Precedent: A Study of
Overruling and Negative Treatment," Law & Society Review 37:1 (2007).
[H11] March, "Exploration and Exploitation in Organizational Learning,"
Organization Science 2(1) (1991).
[H12] Argyris, "Double Loop Learning in Organizations," Harvard Business Review
(1977); Wegner, Giuliano & Hertel, "Cognitive Interdependence in Close
Relationships" (1985; transactive memory).

Industry analysis and commentary — not peer-reviewed, and marked as such in-text:

[H6-industry] Howson, "The Analytics Landscape in 2016," Forrester (source of the
~80% mediated-consumption finding); Davenport et al., Deloitte access-gap surveys
(2018). Analyst methodology not independently verified for this note.
[H7-commentary] Institute for Product Management, "AI Network Effects" (four
flywheel gates; vertical-specificity of application-layer data advantages).
