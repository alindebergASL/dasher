import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

interface Clause {
  label: string;
  pattern: RegExp;
}

function readDocument(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const readme = readDocument("../../../README.md");
const roadmap = readDocument(
  "../../../docs/roadmap/2026-07-30-private-pilot-roadmap.md",
);
const productRequirements = readDocument(
  "../../../docs/product/PRODUCT_REQUIREMENTS.md",
);
const adr003 = readDocument(
  "../../../docs/architecture/ADR-003-multi-tenant-control-plane.md",
);
const adr004 = readDocument(
  "../../../docs/architecture/ADR-004-provider-oauth-mcp-boundaries.md",
);
const adr005 = readDocument(
  "../../../docs/architecture/ADR-005-agentic-dashboard-harness.md",
);
const historicalProductSpine = readDocument(
  "../../../docs/plans/2026-07-30-product-spine.md",
);
const dashboardLifecyclePlan = readDocument(
  "../../../docs/plans/2026-08-01-dashboard-lifecycle-and-agent-harness.md",
);
const plan = readDocument(
  "../../../docs/plans/2026-07-30-executive-brief-gate.md",
);
const validation = readDocument(
  "../../../docs/validation/2026-07-30-executive-brief-gate.md",
);
const rehearsal = readDocument(
  "../../../docs/validation/2026-07-30-six-agent-executive-brief-rehearsal.md",
);

interface RoadmapGateBoundary {
  key: string;
  text: string;
}

interface ExactClause {
  label: string;
  text: string;
}

interface DocumentClauseContract {
  label: string;
  document: string;
  clauses: ExactClause[];
}

const expectedRoadmapGateBoundaries = JSON.parse(
  readDocument("./private-pilot-gate-boundaries.json"),
) as RoadmapGateBoundary[];

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeClauseText(value: string): string {
  return normalizeWhitespace(value).replaceAll("`", "");
}

function exactClause(label: string, text: string): ExactClause {
  return { label, text: normalizeClauseText(text) };
}

function replaceOccurrence(
  source: string,
  search: string,
  occurrence: number,
  replacement: string,
): string {
  let from = 0;
  let found = -1;
  for (let index = 0; index < occurrence; index += 1) {
    found = source.indexOf(search, from);
    if (found < 0)
      throw new Error(`missing occurrence ${occurrence}: ${search}`);
    from = found + search.length;
  }
  return `${source.slice(0, found)}${replacement}${source.slice(found + search.length)}`;
}

function parseRoadmapGateBoundaries(document: string): RoadmapGateBoundary[] {
  const boundaries: RoadmapGateBoundary[] = [];
  const counts = new Map<string, number>();
  let gate: string | null = null;
  let current: string[] = [];

  const flush = () => {
    if (gate && current.length > 0) {
      const text = normalizeWhitespace(current.join(" "));
      if (text.length > 0) {
        const count = (counts.get(gate) ?? 0) + 1;
        counts.set(gate, count);
        boundaries.push({
          key: `${gate}-${String(count).padStart(2, "0")}`,
          text,
        });
      }
    }
    current = [];
  };

  for (const line of document.split("\n")) {
    const gateHeading = line.match(/^## Gate ([2-7]) — .+$/);
    if (gateHeading?.[1]) {
      flush();
      gate = `gate${gateHeading[1]}`;
      current = [line.slice(3)];
      flush();
      continue;
    }
    if (gate && line.startsWith("## ")) {
      flush();
      gate = null;
      continue;
    }
    if (!gate) continue;
    if (line.startsWith("### ")) {
      flush();
      current = [line];
      flush();
      continue;
    }
    if (line.trim().length === 0) {
      flush();
      continue;
    }
    if (line.startsWith("- ")) {
      flush();
      current = [line];
      continue;
    }
    current.push(line);
  }
  flush();
  return boundaries;
}

const modelIds = [
  "claude-fable-5",
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-haiku-4-5-20251001",
  "gpt-5.6-sol",
  "gpt-5.6-luna",
] as const;

function modelClauses(documentLabel: string): Clause[] {
  return modelIds.map((model) => ({
    label: `${documentLabel} model ${model}`,
    pattern: new RegExp("`" + model.replaceAll(".", "\\.") + "`"),
  }));
}

const readmeClauses: ExactClause[] = [
  exactClause(
    "README accepted synthetic links",
    `- [Executive Brief owner-accepted synthetic validation](docs/validation/2026-07-30-executive-brief-gate.md)
    - [Six-agent Executive Brief rehearsal](docs/validation/2026-07-30-six-agent-executive-brief-rehearsal.md)`,
  ),
  exactClause(
    "README no human-equivalent claim",
    `No human sessions occurred, the agents are not represented as human
    equivalents, and no 30-second human-usability claim is made.`,
  ),
  exactClause(
    "README honest provider diversity",
    `The six model IDs are distinct, but provider diversity is not six-way: four are
    Claude-family models and two are OpenAI models run through Codex.`,
  ),
  exactClause(
    "README later gates independent",
    `Later security, real-data, manager-user, and protected-release gates remain
    independent.`,
  ),
];

const productRequirementClauses: ExactClause[] = [
  exactClause(
    "PRD governed decision loop",
    `Dasher is not an AI dashboard generator. It is a governed decision loop that
    turns a bounded plain-language intent and authorized evidence into a safe
    managerial action and durable decision memory.`,
  ),
  exactClause(
    "PRD prospective Workspace Board Scratch Published grammar",
    `The pilot target is a Workspace container/registry with multiple Boards and
    Scratches, not a single dashboard per user or organization. A Scratch is a
    disposable dashboard; a Board is a durable dashboard. Published is a later
    reviewed audience projection of one immutable Board version, never a dashboard
    kind, lifecycle state, active, or working head. Decision Snapshots and Recipes
    are separately gated future product records.`,
  ),
  exactClause(
    "PRD durable lifecycle",
    `- Durable dashboards preserve version history, support manual refresh and an
    explicitly authorized schedule, preserve the prior good version on failure,
    and show what changed since an identified prior version with value and
    provenance.`,
  ),
  exactClause(
    "PRD exact disposable TTL no renewal and cleanup",
    `- Disposable dashboards require an explicit expiry, cannot schedule recurring
    work, revoke access and enter secure cleanup at expiry, and expose
    cleanup state. The default TTL is 24 hours, with 1-hour/24-hour/7-day/30-day
    user presets, a 1-hour minimum, and a hard maximum of 30 days from creation;
    an organization administrator may set the default only from 1 hour through 7
    days. Expiry is fixed at creation and inclusive at now >= expires_at; there
    is no renewal or arbitrary-timestamp pilot UX.`,
  ),
  exactClause(
    "PRD promotion preserves lineage without publication or authority",
    `- An authorized user may explicitly promote an unexpired disposable dashboard
    to durable. Promotion preserves snapshots, evidence, accepted and candidate
    versions, calculations, and origin lineage; it does not silently add a
    schedule, source authority, publication, or audience. The promoted Board head
    remains private until separately reviewed/published; a Board cannot become a
    Scratch, and pin/bookmark/share never extends Scratch TTL.`,
  ),
  exactClause(
    "PRD lifecycle direction is prospective",
    `These are approved product directions, not implemented capabilities in the
    current foundation.`,
  ),
  exactClause(
    "PRD five-slot 30-second goal and two-interaction evidence",
    `The 30-second default projection has fixed Known, Changed, Important, Next safe
    action, and Evidence slots. Freshness, metric-contract, or comparison failure
    displaces the affected insight rather than becoming a footnote. A change drawer
    is the first interaction and technical evidence lineage the second; raw run
    logs are not required for manager use.`,
  ),
  exactClause(
    "PRD governed creative envelope",
    `Within a reviewed component and calculation contract, it may explore
    narratives, layouts, components, metrics, comparisons, and transformations.
    Governed does not mean template-bound.`,
  ),
  exactClause(
    "PRD typed calculation validation and execution",
    `Models may propose typed calculation graphs and safe expressions; trusted
    deterministic services validate types, units, evidence, authorization,
    resources, and policy, then execute accepted graphs.`,
  ),
  exactClause(
    "PRD capability-scoped current authorization",
    `Tools are typed and capability-scoped, with current authorization checked on
    every use and result commit.`,
  ),
  exactClause(
    "PRD append-only run and evidence ledger",
    `Runs and checkpoints have a durable append-only ledger and claim-to-source
    evidence chain.`,
  ),
  exactClause(
    "PRD human approval boundaries",
    `Autonomy is tiered, and a human must approve new or broadened authority,
    sources/connections, publication or audience, and recurring schedules or
    costs.`,
  ),
  exactClause(
    "PRD provider-neutral prospective harness",
    `Provider access is neutral behind the model gateway; fake-provider, replay,
    adversarial, and evaluation modes precede live enablement. ADR-005 defines
    the proposed architecture and gates; none of these harness capabilities is
    claimed as implemented.`,
  ),
  exactClause(
    "PRD external IdPs optional",
    `External identity providers are optional integrations, not a prerequisite for
    the product.`,
  ),
  exactClause(
    "PRD optional and organization-required IdPs",
    `Organizations may optionally enable Google Workspace or Microsoft Entra OIDC
    and may require an approved IdP by policy.`,
  ),
  exactClause(
    "PRD no automatic email linking",
    `Email is a delivery address and invitation/account binding, not canonical
    identity. Dasher must not automatically link accounts because email addresses
    match across credentials or providers. Linking requires an explicit,
    reauthenticated, policy-allowed, audited action that proves control of both
    bindings.`,
  ),
  exactClause(
    "PRD identity implementation and migration status",
    `The current foundation does not provide local authentication, magic links, or
    external-IdP login. Immutable identity migrations remain unchanged; any
    required credential-binding evolution must be planned and added through a
    new forward-only migration.`,
  ),
  exactClause(
    "PRD generated-code gate closed",
    `Generated code is a possible future isolated extension, not a pilot
    capability. docs/security/GENERATED_CODE_GATE.md remains Status: CLOSED.`,
  ),
  exactClause(
    "PRD declarative DashboardSpec",
    `During the pilot, models may propose only a strict declarative DashboardSpec;
    reviewed deterministic services compute metrics, and the reviewed renderer
    displays validated component kinds.`,
  ),
  exactClause(
    "PRD no provider-hosted tools around the gate",
    `No trusted-process execution, provider-hosted web search or code interpreter,
    model tool, arbitrary stdio MCP, browser-origin execution, or generated
    workload access to credentials may bypass the gate.`,
  ),
];

const adr003Clauses: ExactClause[] = [
  exactClause(
    "ADR-003 target is not current implementation",
    `This is an accepted target architecture, not a description of the current
    fixture-only foundation. The foundation has no identity, tenant database,
    uploads, live connector, provider access, durable jobs, or deployment.`,
  ),
  exactClause(
    "ADR-003 amendment is prospective",
    `The 2026-07-31 product amendment adds a provider-neutral verified-principal
    target, optional external IdPs, and first-class durable and disposable
    dashboard lifecycles. It does not claim those capabilities exist.`,
  ),
  exactClause(
    "ADR-003 generated-code gate closed",
    `Generated-code execution remains CLOSED under
    docs/security/GENERATED_CODE_GATE.md.`,
  ),
  exactClause(
    "ADR-003 declarative DashboardSpec boundary",
    `They may propose data mappings, classifications, plans, explanations, and a
    strict DashboardSpec; they do not grant authority.`,
  ),
  exactClause(
    "ADR-003 trusted deterministic authority",
    `Authoritative decisions come from server-derived identity and current
    membership, PostgreSQL-enforced tenant policy, immutable source and dashboard
    records, brokered capabilities, deterministic calculations, and explicit
    human approval. Deterministic services compute displayed metrics.`,
  ),
  exactClause(
    "ADR-003 optional external IdPs",
    `The target includes a built-in passwordless path, with email magic links as the
    proposed default. Email is a verified delivery and invitation/account binding,
    not canonical identity; changing an address must not replace the stable
    principal. Optional Google Workspace and Microsoft Entra OIDC integrations may
    also verify principals. An organization may require an approved IdP, but an
    external IdP is not a universal product dependency.`,
  ),
  exactClause(
    "ADR-003 no automatic email linking",
    `Matching email addresses never automatically merge users, credentials, or
    provider identities. Linking requires an explicit, recent-authentication,
    policy-allowed operation that proves control of both bindings and atomically
    records the actor, principals, providers, outcome, and authority revision in
    the audit trail.`,
  ),
  exactClause(
    "ADR-003 identity status and immutable migrations",
    `This target does not claim local authentication, magic links, OIDC, or identity
    linking exists. Immutable migrations 0001_identity_audit.sql and
    0002_security_boundary.sql retain their current (issuer, subject) identity
    contract and are not edited.`,
  ),
  exactClause(
    "ADR-003 durable and disposable lifecycle",
    `- The workspace may contain multiple durable and disposable dashboards.
    Durable dashboards retain version and refresh history plus typed
    changed-since value and provenance. Disposable dashboards have explicit
    expiry, no recurring work by default, access revocation and secure cleanup
    states, and an explicit promotion path that preserves snapshot, evidence,
    version, calculation, and origin lineage.`,
  ),
  exactClause(
    "ADR-003 append-only run and evidence record",
    `- Agentic runs and checkpoints follow the same append-only principle. Their
    durable record covers plans, bounded specialist/reviewer work, tool attempts,
    authorization outcomes, candidates, calculation graphs, validation feedback,
    approvals, model/provider metadata, costs, and terminal outcomes without
    storing credentials.`,
  ),
  exactClause(
    "ADR-003 schema sequencing",
    `Dashboard expiry, cleanup, promotion, refresh, and run/checkpoint transitions
    must be documented and planned before their immutable schema is authored.`,
  ),
  exactClause(
    "ADR-003 capability reauthorization",
    `The same rule applies to every agentic typed-tool use and result commit. A
    capability is narrow, typed, purpose-bound, tenant-bound, revocable, expiring,
    and budgeted; it is not a bearer of ambient authority.`,
  ),
  exactClause(
    "ADR-003 human approval boundaries",
    `Human approval is required before new or broadened authority, a source or
    connection, a publish or audience transition, or recurring schedule/cost can
    be crossed.`,
  ),
];

const adr004Clauses: ExactClause[] = [
  exactClause(
    "ADR-004 target is not current implementation",
    `This ADR accepts boundaries and dispositions; it does not claim a gateway,
    credential store, OAuth integration, or MCP broker exists in the current
    fixture foundation.`,
  ),
  exactClause(
    "ADR-004 amendment does not enable implementation",
    `The 2026-07-31 amendment distinguishes optional sign-in IdPs from model and
    source-provider authorization and aligns the gateway and typed-tool boundaries
    with the proposed agentic harness in ADR-005. It does not enable any provider,
    tool, OAuth, or authentication path.`,
  ),
  exactClause(
    "ADR-004 optional external IdPs",
    `External IdPs are optional sign-in integrations behind ADR-003's provider-
    neutral verified-principal boundary. The target built-in path is passwordless,
    with email magic links as the proposed default; optional Google Workspace and
    Microsoft Entra OIDC may be enabled, and an organization may require an
    approved IdP.`,
  ),
  exactClause(
    "ADR-004 no automatic email linking",
    `Email is a delivery and invitation/account binding, not a principal identifier.
    No email match automatically links a built-in credential, Google identity,
    Microsoft identity, model-provider account, or source connection. Linking is a
    separate, reauthenticated, policy-allowed, audited operation that proves both
    identity bindings.`,
  ),
  exactClause(
    "ADR-004 identity status and immutable migrations",
    `This ADR does not claim any local-authentication, magic-link, OIDC, or linking
    implementation exists, and immutable migrations 0001 and 0002 are not changed
    by this direction.`,
  ),
  exactClause(
    "ADR-004 provider inference-only",
    `Disable provider-hosted web search, code interpreters, file tools, remote MCP,
    and other tools. Provider requests are inference-only.`,
  ),
  exactClause(
    "ADR-004 governed creative envelope",
    `Models may classify source fields, propose mappings and adaptive plans, explore
    multiple narratives, layouts, supported components, metrics, comparisons, and
    transformations, explain deterministic results, and propose multiple strict
    versioned DashboardSpec candidates.`,
  ),
  exactClause(
    "ADR-004 not template-bound",
    `Governed output is not limited to a fixed template catalog.`,
  ),
  exactClause(
    "ADR-004 typed calculation graphs",
    `Within ADR-005's governed harness, a model may propose typed calculation graphs
    and safe expressions and revise a candidate from structured validation
    feedback.`,
  ),
  exactClause(
    "ADR-004 deterministic validation and execution",
    `Trusted deterministic services validate and execute accepted calculations;
    model output is not an authoritative metric.`,
  ),
  exactClause(
    "ADR-004 generated-code gate closed",
    `Generated-code execution remains CLOSED.`,
  ),
  exactClause(
    "ADR-004 capability-scoped current authorization",
    `The inference provider remains tool-free. ADR-005's orchestrator may request a
    typed operation only through Dasher's capability broker. Each capability binds
    an organization, actor or service, run purpose, tool and operation, approved
    resources and source connection, policy/manifest revision, expiry, and call,
    resource, and cost limits. Current authorization and capability state are
    checked before every call and before its result commits.`,
  ),
  exactClause(
    "ADR-004 approval and append-only evidence ledger",
    `Authority/source, publish/audience, and recurring-cost boundaries require human
    approval. Tools, candidates, validation feedback, approvals, provider metadata,
    usage, checkpoints, and evidence lineage are recorded in ADR-005's proposed
    append-only run ledger.`,
  ),
  exactClause(
    "ADR-004 harness remains prospective",
    `This alignment does not claim the broker, ledger, harness, or gateway is
    implemented.`,
  ),
];

const adr005Clauses: ExactClause[] = [
  // Pinned as Proposed until 2026-08-31, when the owner accepted the ADR (as
  // amended by Requirements Amendment 01) to unblock the model-planner work.
  // The clause still pins the status line so a silent edit — in either
  // direction — fails here rather than drifting.
  exactClause(
    "ADR-005 accepted status",
    `Status: Accepted by owner direction, 2026-08-31, as amended by Requirements
    Amendment 01`,
  ),
  exactClause(
    "ADR-005 target is not current implementation",
    `This ADR records an owner-approved product direction as a proposed target
    architecture. It does not claim that the harness, identity paths, dashboard
    lifecycle, tools, ledger, provider gateway, scheduling, or cleanup exists.`,
  ),
  exactClause(
    "ADR-005 governed creative orchestrator",
    `The agentic dashboard harness is a core product capability. Dasher will start
    with one governed adaptive orchestrator per run. The orchestrator may form and
    revise dynamic plans, request bounded specialist or reviewer passes, generate
    multiple creative candidate DashboardSpec values, and respond structurally to
    validation feedback.`,
  ),
  exactClause(
    "ADR-005 typed calculation validation and execution",
    `Trusted deterministic services validate and execute approved typed operations;
    they do not dictate the dashboard's ideas. Models may propose typed calculation
    graphs and safe expressions. Trusted validators and execution services enforce
    schema, operation allowlists, types, units, evidence coverage, authorization,
    resource ceilings, and policy before any result can become a candidate.`,
  ),
  exactClause(
    "ADR-005 capability ledger and approval boundaries",
    `The harness will use capability-scoped typed tools, current authorization on
    every use, an append-only run event ledger with rebuildable mutable projections/
    checkpoints, an end-to-end evidence chain, explicit autonomy tiers, and human
    approval at authority, source, publish, and recurring-cost boundaries.`,
  ),
  exactClause(
    "ADR-005 generated-code gate and declarative DashboardSpec",
    `Generated-code execution remains CLOSED. The only presentation output is a
    validated, versioned declarative DashboardSpec.`,
  ),
  exactClause(
    "ADR-005 governed is not template-bound",
    `Governed does not mean template-bound. The boundary is deliberately split:`,
  ),
  exactClause(
    "ADR-005 creative envelope",
    `- create and compare multiple candidate dashboard narratives, page structures,
    layouts, supported component combinations, metrics, comparisons, and
    transformations;`,
  ),
  exactClause(
    "ADR-005 Workspace meaning",
    `- **Workspace:** the container and registry holding multiple Boards and
    Scratches. It is not a dashboard kind or lifecycle state.`,
  ),
  exactClause(
    "ADR-005 Scratch meaning",
    `- **Scratch:** a dashboard whose current_kind is disposable. It has
    immutable versions and a current working head, a fixed visible expiry, no
    renewal, and no schedule. Pinning or bookmarking never extends its TTL.`,
  ),
  exactClause(
    "ADR-005 Board meaning",
    `- **Board:** a dashboard whose current_kind is durable. Its lifecycle is
    draft, active, or archived; its working head may be newer than its most
    recently Published revision.`,
  ),
  exactClause(
    "ADR-005 Published meaning",
    `- **Published:** a reviewed, audience-authorized projection of one immutable
    Board version through an explicit publication/version relation. Published is
    never a third dashboard kind, lifecycle state, synonym for active, or
    synonym for the working head.`,
  ),
  exactClause(
    "ADR-005 head active and promotion do not publish",
    `Workspace, Scratch, Board, Published, Decision Snapshot, and Recipe retain
    their normative meanings. head_version_id, active, and promotion are never
    publication/audience authority.`,
  ),
  exactClause(
    "ADR-005 durable lifecycle",
    `A durable dashboard is intended to remain useful over time. It has insert-only
    version history, manual refresh and an explicitly authorized schedule,
    prior-good-version preservation, and visible changed-since value with the
    provenance that supports that comparison.`,
  ),
  exactClause(
    "ADR-005 fixed disposable TTL and no renewal",
    `- The disposable default TTL is 24 hours. The minimum is 1 hour and the hard
    maximum is 30 days from creation. An organization administrator may set the
    organization default only from 1 hour through 7 days.
    - Pilot creation offers exactly 1h, 24h, 7d, and 30d presets; it has no
    arbitrary timestamp control. The selected expiry and the organization
    default/policy revision are visible before confirmation and on the dashboard.
    - TTL is fixed at creation. Both the original expiry and current effective
    expiry are recorded; a disposable dashboard cannot extend or renew either.
    Inclusive expiry is database_now >= expires_at. A user who needs the work
    to persist requests promotion instead of extending it.
    - Disposable dashboards cannot schedule recurring work. This is a hard
    lifecycle rule, not a hidden default that an API or model may override.`,
  ),
  exactClause(
    "ADR-005 immediate access revocation and quarantine",
    `A disposable dashboard is optimized for quick, bounded use. Expiry or explicit
    delete immediately revokes product access, capabilities, head/version/source/
    evidence projections, and cache eligibility regardless of worker or scheduler
    lag.`,
  ),
  exactClause(
    "ADR-005 inaccessible quarantine and purge boundary",
    `Revoked content enters a 24-hour inaccessible quarantine, with
    purge_after = access_revoked_at + 24 hours. Purge may start only at/after
    purge_after, targets completion by purge_after + 24 hours, and never
    restores access while waiting.`,
  ),
  exactClause(
    "ADR-005 four deletion milestones",
    `Retention reporting distinguishes four milestones rather than calling all of
    them deletion:

    1. **Product access revocation:** immediate and database-authoritative.
    2. **Logical retention/recovery expiry:** quarantine, claim-aware purge, and the
       35-day Dasher recoverability objective.
    3. **Cryptographic unrecoverability:** a later claim requiring verified
       destruction or inaccessibility of every relevant key copy and backup plus
       retained evidence.
    4. **Provider physical-media deletion:** a provider-specific timeline and
       evidence obligation, separate from Dasher's logical or cryptographic state.`,
  ),
  exactClause(
    "ADR-005 physical deletion honesty",
    `The 35-day objective is not proof that a provider
    has deleted a particular row from physical media by day 35.`,
  ),
  exactClause(
    "ADR-005 operator legal hold never restores access and release is audited",
    `Legal hold is a dedicated operator-only capability, not an organization-admin
    or application capability. A dashboard/resource may have multiple independent
    holds. Each hold and release carries an independent opaque hold ID, opaque
    case/matter reference, authority revision, actor, reason hash, and audit event;
    release is equally privileged. A hold blocks purge only: it never changes TTL,
    access, schedules, capabilities, quarantine, or ordinary lifecycle state.`,
  ),
  exactClause(
    "ADR-005 promotion expiry locked race protocol",
    `An editor may request promotion and an organization administrator may approve
    it. A request does not pause expiry and shows its pending/approved/denied/
    expired status. Promotion uses the same-organization advisory gate, locks the
    dashboard row, obtains database time after the lock, and revalidates
    lifecycle_revision, authority, policy, and state. It commits only when
    database_now < expires_at; the inclusive boundary belongs to expiry. The
    winner updates the lifecycle revision and writes its fixed audit event in the
    same transaction. Audit failure rolls back the would-be winner.`,
  ),
  exactClause(
    "ADR-005 expiry winner denies promotion",
    `An expiry
    winner denies promotion. A durable dashboard cannot transition back to
    disposable.`,
  ),
  exactClause(
    "ADR-005 lineage-preserving private promotion",
    `Successful promotion is an in-place current_kind transition to durable. It
    preserves the dashboard ID, disposable origin, original expiry, versions,
    current head, snapshots, evidence, calculation lineage, and policy evidence.
    It clears effective expiry only as part of that transition and adds no source,
    audience, publication, schedule, or other authority. The promoted Board and its
    working head remain private until a separate reviewed publication.`,
  ),
  exactClause(
    "ADR-005 evidence is not Claim-level provenance",
    `Evidence records are support artifacts, not semantic Claims. The 0003
    dashboard_version_evidence relation is revision-level provenance only; it does
    not prove claim-level coverage.`,
  ),
  exactClause(
    "ADR-005 recorded-result replay never redispatches",
    `Deterministic orchestration means that trusted control flow can be reconstructed
    from pinned inputs and recorded outcomes. It does not mean model output is
    deterministic. Replay consumes immutable recorded model and tool results; it
    never re-calls a model or tool expecting identical output.`,
  ),
  exactClause(
    "ADR-005 lease epoch fences every acceptance path",
    `Every worker acquisition atomically increments a monotonic lease_epoch. The
    current epoch is required on every event, external result, checkpoint,
    artifact/head/cache commit, budget reserve/reconcile/release, and outbox
    dispatch. A TTL lease without the epoch is not a fence.`,
  ),
  exactClause(
    "ADR-005 strict typed JSON AST",
    `A model may propose a calculation as a typed directed acyclic graph. Its wire
    form is a strict discriminated JSON AST inspired by CEL's typed-expression
    approach; it is not unrestricted CEL source and is not JSON Logic source. Each
    operation has one schema, required fields, and additionalProperties: false.
    Unknown operation, key, schema/registry version, field, or literal kind fails.`,
  ),
  exactClause(
    "ADR-005 no arbitrary expression execution",
    `There is no arbitrary code, SQL, regular expression, dynamic property path,
    dynamic function, implicit join, general recursion, or unbounded cardinality.`,
  ),
  exactClause(
    "ADR-005 atomic budget reservation and indeterminate billing",
    `Before every paid or external call, the gateway atomically resolves the exact
    provider/model and versioned price book, conservatively estimates worst case,
    reserves every relevant counter, appends attempt_reserved, and commits before
    dispatch. It persists response/usage and atomically reconciles reserved to
    used/released counters. Unknown pricing or token estimation denies. A timeout
    after dispatch is billing-indeterminate and does not release its reservation
    until provider reconciliation or an explicit quarantine-expiry/operator policy
    decision.`,
  ),
  exactClause(
    "ADR-005 five-slot 30-second projection",
    `Every manager-facing Board or Scratch reserves five fixed above-fold slots:`,
  ),
  exactClause(
    "ADR-005 evidence within two interactions",
    `The first interaction opens a change drawer with values, contributors, Events,
    caveats, evidence, and proposed action. The second opens technical lineage:`,
  ),
  exactClause(
    "ADR-005 current tool reauthorization",
    `Before each tool attempt and before accepting its result, the broker verifies
    current membership or service authority, capability state, source and
    connection approval, credential version, policy, dashboard state, expiry, and
    budget.`,
  ),
  exactClause(
    "ADR-005 provider inference-only",
    `Provider-hosted tools remain disabled: the orchestrator requests tools through
    Dasher's broker, and the provider receives inference-only requests through
    ADR-004's gateway.`,
  ),
  exactClause(
    "ADR-005 human approval boundaries",
    `Regardless of tier, a human must approve any new or broadened authority, source
    or connection, publication or audience change, and new or increased recurring
    schedule/cost.`,
  ),
  exactClause(
    "ADR-005 governed refresh cannot auto-advance",
    `3. **Governed refresh:** refresh an existing durable dashboard only within a
    previously human-approved source set, schedule, and cost ceiling, producing
    a private validated candidate while the prior good head remains active. New
    authority still pauses for approval.`,
  ),
  exactClause(
    "ADR-005 passwordless is a separate forward migration",
    `Passwordless identity is a later forward migration, never part of dashboard
    migration 0003. The built-in issuer uses an opaque stable subject; email is
    only a verified delivery and invitation/account binding.`,
  ),
  exactClause(
    "ADR-005 schema and plan sequencing",
    `- This proposed ADR and a reviewed implementation plan precede any new
    immutable dashboard-schema migration or harness implementation.`,
  ),
  exactClause(
    "ADR-005 immutable migrations",
    `- Immutable migrations 0001_identity_audit.sql and
    0002_security_boundary.sql are not edited. Required identity and dashboard
    evolution uses separately reviewed, forward-only migrations.`,
  ),
  exactClause(
    "ADR-005 0003 precedes agent ledger",
    `Migration 0003 is not authored until the successor plan's lifecycle-safe
    control row, access derivation, evidence links, retention claims, purge seam,
    fixed function/ACL inventory, and adversarial matrix pass dual documentation
    review. The agent-run ledger and passwordless identity are 0004+ concerns;`,
  ),
  exactClause(
    "ADR-005 DashboardSpec version contract",
    `- Existing DashboardSpec 1.0 remains readable without executiveBrief and
    rejects executiveBrief; 1.1 remains the current Executive Brief contract and
    requires its strict evidence-linked executiveBrief. Lifecycle metadata, typed
    calculation graphs, safe-expression fields, or component-contract expansion
    must not be added silently to 1.0 or 1.1. Any serialized-spec expansion
    requires an explicit new schema version, a strict validator, deterministic
    migration or adaptation, and backward-compatibility and unknown-field
    rejection tests.`,
  ),
  exactClause(
    "ADR-005 versioned compatibility and closed gate",
    `- The harness remains compatible with those versioned declarative DashboardSpec
    contracts, and
    docs/security/GENERATED_CODE_GATE.md remains exactly Status: CLOSED.`,
  ),
];

const historicalProductSpineClauses: ExactClause[] = [
  exactClause(
    "historical plan preserves completed Tasks 1-7 and foundation contract",
    `Tasks 1–7 are
    > completed and merged. Preserve their requirements as the historical contract
    > for immutable migrations 0001 and 0002 and the current identity/session
    > foundation.`,
  ),
  exactClause(
    "historical plan supersedes and holds minimal DDL and Tasks 8-11",
    `The minimal immutable-content DDL below and Tasks 8–11 are
    > superseded and on **HOLD**: they must not be implemented, copied into a
    > migration, or used to claim Gate 2-A completion`,
  ),
  exactClause(
    "historical plan forbids creating 0003 before successor acceptance",
    `docs/plans/2026-08-01-dashboard-lifecycle-and-agent-harness.md has been
    > accepted. In particular, do not create 0003_immutable_content.sql from this
    > document.`,
  ),
  exactClause(
    "historical plan requires lifecycle-safe seams before 0003 freeze",
    `The successor plan retains the useful source, evidence, isolation,
    > immutability, CAS, and audit requirements while adding the lifecycle,
    > revocation, retention, evidence-link, and purge seams that must exist before
    > 0003 bytes freeze.`,
  ),
];

const dashboardLifecyclePlanClauses: ExactClause[] = [
  exactClause(
    "successor plan holds unsafe 0003",
    `Tasks 1–7 of the 2026-07-30 product-spine plan are completed and merged. Its
    minimal immutable-content DDL and Tasks 8–11 are on HOLD and must not be used.
    Do not author 0003_immutable_content.sql until this exact docs tree has passed
    dual review and this successor plan is accepted.`,
  ),
  exactClause(
    "successor plan preserves immutable 0001 and 0002",
    `This plan does not change 0001 or 0002. Their expected SHA-256 values at the
    planning base are:`,
  ),
  exactClause(
    "successor plan generated-code gate closed",
    `Generated code remains Status: CLOSED. Synthetic/public bounded fixtures are
    the only permitted content in this slice.`,
  ),
  exactClause(
    "successor plan exact disposable TTL and no renewal",
    `- Disposable TTL defaults to 24 hours; minimum 1 hour; hard maximum 30 days
    from creation. Organization-admin default is 1 hour through 7 days. Pilot
    presets are exactly 1h/24h/7d/30d, with no arbitrary timestamp.
    - TTL is database-authoritative, visible, fixed at creation, and expires at
    database_now >= effective_expires_at. There is no extension/renewal and no
    recurring work. Promotion is the persistence path.`,
  ),
  exactClause(
    "successor plan immediate access revocation and quarantine",
    `- Expiry/delete revokes access immediately, then 24-hour inaccessible
    quarantine with purge_after = access_revoked_at + 24 hours. Purge begins no
    earlier than purge_after. Its completion target is 24 hours later.`,
  ),
  exactClause(
    "successor plan lifecycle transition table is exhaustive",
    `The table is exhaustive. “Once” means one increment in the same transaction;
    unchanged epochs remain exactly unchanged. Operation decision time is captured
    from the database after the required locks. Creation and restore-as-new are
    revision-zero insertions, not lifecycle mutations.`,
  ),
  exactClause(
    "successor plan promotion requires active validated unexpired Scratch",
    `| Promotion approval | disposable active -> durable active | Existing non-null validated head; approved request and expected revision; locked time strictly before effective expiry; no cleanup state; original expiry retained, effective expiry cleared, promoted_at set | dasher_api.decide_dashboard_promotion | lifecycle revision, capability epoch, and cache epoch each +1 | promotion_approved | dashboard.promotion_approved |`,
  ),
  exactClause(
    "successor plan creation and first head transition rows",
    `| Create | absent -> draft | Requested disposable with fixed valid expiry or born-durable with null expiry; head_version_id IS NULL; revocation/purge/archive/promotion timestamps null | dasher_api.create_dashboard | lifecycle_revision = capability_epoch = cache_epoch = 0 | none | existing dashboard.created |
    | First validated head CAS | draft -> active | Either kind; target head is non-null, same-tenant, immutable, and validated; lifecycle timestamps unchanged | dasher_api.compare_and_swap_dashboard_head | lifecycle revision +1; capability/cache epochs unchanged | head_activated | existing dashboard_head.promoted |
    | Later validated head CAS | active -> active | Either kind; replacement head is non-null, same-tenant, immutable, and validated; lifecycle timestamps unchanged | dasher_api.compare_and_swap_dashboard_head | lifecycle revision +1; capability/cache epochs unchanged | head_advanced | existing dashboard_head.promoted |`,
  ),
  exactClause(
    "successor plan archive transition rows",
    `| Archive | durable active -> archived | Existing non-null validated head; archived_at set to decision time | dasher_api.set_dashboard_archive | lifecycle revision, capability epoch, and cache epoch each +1 | archived | dashboard.archived |
    | Unarchive | durable archived -> active | Existing non-null validated head; archived_at cleared after its prior value is captured in event/audit provenance | dasher_api.set_dashboard_archive | lifecycle revision, capability epoch, and cache epoch each +1 | unarchived | dashboard.unarchived |`,
  ),
  exactClause(
    "successor plan revocation transition rows",
    `| Expiry materialization | disposable draft \\| active -> access_revoked | Locked time >= effective_expires_at; head may be null or non-null; set revocation time/reason and purge_after = access_revoked_at + 24 hours; create tombstone and cleanup coordination | dasher_retention_api.materialize_dashboard_expiry | lifecycle revision, capability epoch, and cache epoch each +1 | expired | dashboard.expired |
    | Explicit delete | accessible disposable/durable draft \\| active \\| archived -> access_revoked | Head may be null or non-null; set locked revocation time/reason and purge_after = access_revoked_at + 24 hours; create tombstone and cleanup coordination | dasher_api.delete_dashboard | lifecycle revision, capability epoch, and cache epoch each +1 | deleted | dashboard.deleted |`,
  ),
  exactClause(
    "successor plan cleanup transition rows",
    `| Start quarantine | access_revoked -> quarantined | Drain/cancellation proof present; revocation timestamps unchanged | dasher_retention_api.claim_dashboard_cleanup | lifecycle revision +1; epochs unchanged | cleanup_started | dashboard.cleanup_started |
    | Mark purge eligible | quarantined -> purge_eligible | Locked time >= purge_after; exact expected revision; no active hold; revocation timestamps unchanged | dasher_retention_api.claim_dashboard_cleanup | lifecycle revision +1; epochs unchanged | purge_eligible | dashboard.purge_eligible |
    | Cleanup lease/retry | cleanup state unchanged | State-derived step only; lease/attempt fields may change | dasher_retention_api.claim_dashboard_cleanup or record_dashboard_cleanup_attempt | no lifecycle revision or epoch change | none; append cleanup-attempt history only | none |`,
  ),
  exactClause(
    "successor plan hold transition rows",
    `| Place hold | state unchanged | Any not-cleaned dashboard/resource with purge_started_at IS NULL; exact expected revision; no access or expiry change | dasher_retention_api.place_dashboard_legal_hold | lifecycle revision +1; epochs unchanged | legal_hold_placed | dashboard.legal_hold_placed |
    | Release hold | state unchanged | Active hold and exact expected revision; no access or expiry change | dasher_retention_api.release_dashboard_legal_hold | lifecycle revision +1; epochs unchanged | legal_hold_released | dashboard.legal_hold_released |`,
  ),
  exactClause(
    "successor plan purge and restore transition rows",
    `| Purge | purge_eligible -> cleaned | No active hold; exact revision; set purge_started_at before destructive work and purged_at only after final proof | dasher_retention_api.purge_dashboard | lifecycle revision +1; epochs unchanged | purged | dashboard.purged |
    | Restore as new | absent -> new durable draft | Source remains revoked/quarantined and restorable; selected immutable version only; new dashboard has null expiry/head and new lineage | dasher_api.restore_dashboard_as_new | new dashboard revision/epochs all 0; source unchanged | none | dashboard.restored_as_new |`,
  ),
  exactClause(
    "successor plan quarantine is strictly non-destructive",
    `Before purge_after, quarantine work is strictly non-destructive. It may
    cancel/fence leases, evict cache, and prepare finalizer/proof state, but it may
    not release an access-bearing claim, delete a version/link/spec/resource or
    artifact byte, set purge_started_at, or make restore unreconstructable.`,
  ),
  exactClause(
    "successor plan lazily seeds initial organization policy",
    `Under the organization advisory gate already held by
    initialize_context, the first create_dashboard for an organization with no
    policy row atomically inserts deterministic revision 1 with
    default_disposable_ttl_seconds = 86400, retention_policy_revision = 1, and
    fixed migration/product-policy provenance; it then locks and reselects that row.
    Concurrent first creates serialize on the existing organization gate.`,
  ),
  exactClause(
    "successor plan creation starts draft and first validated head activates",
    `Creation always sets lifecycle_state = 'draft' for both disposable and durable
    dashboards; creation itself never creates an active dashboard. The only
    initial draft -> active transition is the first successful validated
    working-head compare-and-swap through the fixed head mutation. It updates the
    head and lifecycle state atomically with its lifecycle event and audit event;
    there is no separate activate function.`,
  ),
  exactClause(
    "successor plan normative product grammar",
    `ADR-005's nouns are normative for schema review:

    - Workspace is a container/registry, not a dashboard kind or lifecycle state.
    - Scratch maps exactly to current_kind = 'disposable'.
    - Board maps exactly to current_kind = 'durable' with draft, active, or
      archived lifecycle.
    - Published is a later reviewed audience projection of one immutable Board
      version. It is not a dashboard kind/state and does not exist as a relation in
      0003.`,
  ),
  exactClause(
    "successor plan head active and promotion are not publication",
    `head_version_id means the current validated working head. It is not a
    publication, audience grant, or claim that the head was human-reviewed for an
    audience. active means lifecycle-accessible, not Published. Scratch-to-Board
    promotion preserves identity/history and produces a private Board working head;
    it grants no publication/audience authority.`,
  ),
  exactClause(
    "successor plan child access derives through lifecycle",
    `There is no broad raw viewer access to snapshots, evidence, versions, links,
    claims, artifacts, lifecycle events, cleanup, or holds. dasher_app has no
    direct table DML. Fixed SECURITY DEFINER projections derive results through a
    currently accessible dashboard and an access-bearing claim at database time.`,
  ),
  exactClause(
    "successor plan revision evidence is not Claims",
    `dashboard_version_evidence is revision-level provenance only. Evidence rows
    are support artifacts, not semantic Claims, and 0003 makes no claim-level
    coverage promise.`,
  ),
  exactClause(
    "successor plan non-ambient retention principal mapping",
    `dasher.retention_service_principal_allowlist is the exact non-ambient mapping
    required by initialize_operator_context.`,
  ),
  exactClause(
    "successor plan provisions no production retention login",
    `0003 provisions no
    production login or production allowlist row. A future production operator
    login, principal enrollment/revision/revocation, credential binding, or
    activation of the tenant legal-admin/separation-of-duties seam requires a
    forward operations and security review; it is not an app-admin action.`,
  ),
  exactClause(
    "successor plan source checks are shape only",
    `dasher.source_snapshots restricts source_kind exactly to
    synthetic_fixture or public_usgs_fixture and checks raw
    canonical_bytes length 1..1048576 bytes. Those structural checks do not
    inspect or prove that contents are public, synthetic, or non-sensitive.`,
  ),
  exactClause(
    "successor plan has no runtime raw-byte ingestion",
    `No
    route/repository/ingestion boundary may accept raw bytes until a separately
    reviewed classification/admission gate exists.`,
  ),
  exactClause(
    "successor plan reference-aware deletion",
    `Destructive claim release begins only from purge_eligible inside
    purge_dashboard. That function releases only access-bearing claims owned by
    the source dashboard, then removes eligible rows owned solely by that dashboard
    (versions, version links, and dashboard-owned artifacts) and shared resource
    bytes only when the same locked transaction proves no active hold and no
    remaining access-bearing or retention-only claim.`,
  ),
  exactClause(
    "successor plan legal hold blocks purge only",
    `Hold rows are mutable only
    through the fixed release function; placement and release lifecycle/audit
    events are append-only. Release is equally privileged, does not delete history,
    and an active hold affects only purge eligibility.`,
  ),
  exactClause(
    "successor plan restore is new identity before purge",
    `Restore scope is exactly one selected immutable source version, not an entire
    parent DAG. restore_dashboard_as_new accepts the source revoked/quarantined
    dashboard, selected source version, collision-checked new dashboard ID and new
    version ID, expected source lifecycle revision, current CSRF/request IDs, and
    bounded provenance.`,
  ),
  exactClause(
    "successor plan excludes future product tables from 0003",
    `Add no agent-run, metric,
    semantic Claim, evidence-manifest, publication, Decision Snapshot, Recipe,
    alert, bookmark/share, or product-UI table.`,
  ),
  exactClause(
    "successor plan defers agent ledger to 0004",
    `The agent-run ledger, checkpoints, model/tool metering, calculation graphs,
    primitive registry, ranker records, and passwordless challenge tables are not
    in 0003.`,
  ),
  exactClause(
    "successor plan separates 0005 decision loop",
    `A separately accepted 0005 plan may add:`,
  ),
  exactClause(
    "successor plan freezes exact signatures before SQL",
    `There are no overloads. Task 8A freezes each identity's exact ordered PostgreSQL
    argument types and return columns in the static migrator/catalog test matrix
    before canonical SQL is authored.`,
  ),
  exactClause(
    "successor plan prepared roles bootstrap only after exact prefix discovery",
    `1. Acquire the migrator advisory lock; discover canonical files; validate exact
       filenames/checksums and the contiguous journal/schema prefix before any role
       creation.
    2. Conditionally bootstrap exactly dasher_retention_definer and
       dasher_retention_operator in one separate pre-SQL transaction only when the
       canonical exact-checksum 0003 file is present and pending and journal/schema
       are the exact validated 0002 prefix.
    3. Revalidate the exact prepared pair, then run the same canonical 0003 SQL and
       journal insertion transaction. SQL creates no role.`,
  ),
  exactClause(
    "successor plan accepts only exact prepared-role failure residue",
    `If canonical 0003 SQL fails after bootstrap, the pair may remain as the sole
    accepted 0002 + prepared-0003-roles residue because PostgreSQL role creation
    committed separately. Rerun accepts only that exact pair with the same pending
    canonical checksum and exact 0002 journal/schema, then retries the same SQL.`,
  ),
  exactClause(
    "successor plan retention roles are exact NOBYPASSRLS and unassumable",
    `Both managed roles are NOLOGIN, NOINHERIT,
    NOBYPASSRLS, have null passwords and no role settings, and carry exact managed
    comments frozen by Task 8A. The operator owns nothing and receives only exact
    EXECUTE on the fixed retention API functions. The definer owns only those
    functions—not tables, schema, sequences, or data—and receives only the exact
    per-relation privileges required by their closed transitions. No runtime, app,
    organization-admin, or general-definer role is a member of or can SET ROLE to
    the definer.`,
  ),
  exactClause(
    "successor plan ordinary retention policies require full authorized context",
    `Retention-table RLS remains forced and the definer remains NOBYPASSRLS.
    The only pre-authorized-context exceptions are the two named bootstrap
    SELECT policies: the self-binding allowlist policy and the single-dashboard
    target-discovery policy. All ordinary retention-table policies—including
    ordinary dashboard access after discovery—require exact
    current_user = dasher_retention_definer, full phase authorized, the
    validated principal/revision and exact capability, the derived target
    organization, and the exact target dashboard where applicable.`,
  ),
  exactClause(
    "successor plan self-binding allowlist remains SELECT-only without tuple locks",
    `Exactly one pre-context forced-RLS policy exists on the allowlist. It permits
    SELECT only when current_user = dasher_retention_definer,
    binding_kind = 'postgres_session_user', and
    binding_subject = session_user. It exposes every exact-binding revision so
    the latest revision—including a disabled revocation—cannot be hidden. It
    requires no transaction-local context because this self-binding lookup is the
    bootstrap authority. Relation and column privileges are SELECT-only;
    bootstrap INSERT, UPDATE, and DELETE deny. The SECURITY DEFINER
    initializer returns no allowlist row, column, count, or existence signal and
    cannot read another session user's binding. Runtime never uses SELECT FOR
    UPDATE, SELECT FOR SHARE, or another tuple-locking read on the allowlist and
    has no allowlist UPDATE/DELETE privilege or policy.`,
  ),
  exactClause(
    "successor plan retention isolation is exactly READ COMMITTED and checked fail-closed",
    `The initializer body order is exact. Before an allowlist read or provisional
    authority context, it requires
    current_setting('transaction_isolation') = 'read committed' and proves every
    reserved bootstrap/full-context key empty. A different reported isolation
    value—including a read uncommitted alias if it is not reported exactly as
    read committed, repeatable read, or serializable—an already-aborted
    transaction, or malformed/prepopulated context establishes no authority.`,
  ),
  exactClause(
    "successor plan initializer is VOLATILE for fresh internal command snapshots",
    `dasher_retention_api.initialize_operator_context is exactly VOLATILE
    SECURITY DEFINER with the hardened search_path = pg_catalog; STABLE or
    IMMUTABLE is forbidden, and catalog identity must report
    provolatile = 'v'. PostgreSQL READ COMMITTED gives each SQL command a fresh
    snapshot, and a VOLATILE function's internal SQL queries may observe a fresh
    snapshot instead of being pinned to the caller query's snapshot as a STABLE/
    IMMUTABLE function would be. This visibility property is part of the authority
    protocol, not a performance annotation.`,
  ),
  exactClause(
    "successor plan authority body order is isolation then gate then distinct post-gate query",
    `It
    then derives its canonical operator-principal advisory gate from the exact
    immutable login-binding tuple
    (binding_kind = 'postgres_session_user', binding_subject = session_user), not
    from an unread allowlist row, and acquires that transaction gate. Only after the
    lock call returns does it execute the self-binding ordinary allowlist SELECT
    as a distinct subsequent internal SQL query. No allowlist row, principal
    revision, enabled/capability value, or predecessor state may be read, cached, or
    materialized before gate acquisition. Under READ COMMITTED, that distinct
    post-gate query obtains the command snapshot after the gate-winning writer
    committed.`,
  ),
  exactClause(
    "successor plan latest allowlist revision decides without enabled fallback",
    `The post-gate query considers all exact-binding revisions and selects the
    single highest
    principal_revision regardless of enabled status. The latest revision must be
    enabled and possess the exact capability requested for the immediately
    following fixed retention operation; a newer disabled revision is revocation
    and never falls back to an older enabled revision. The initializer validates
    the required predecessor/hash chain. Missing rows, duplicate-at-revision,
    malformed chain, stale selection, latest-disabled state, or absent capability
    all normalize to denial.`,
  ),
  exactClause(
    "successor plan every allowlist writer shares binding advisory gate",
    `Every
    allowlist writer—the migration-owner synthetic test seed/owner-only cleanup and
    any future separately reviewed production enrollment, revision, or revocation
    mechanism—must derive and acquire the same binding transaction advisory gate
    before INSERT or owner-only cleanup; no other writer path exists. The shared
    gate serializes append-only authority publication/revocation against
    initialization. Because it remains held for the initializer transaction, the
    selected latest revision is stable for that authority decision without
    UPDATE privilege or a tuple lock. Every later fixed retention function
    revalidates the exact bound principal revision under the same still-held gate
    and denies stale or malformed context.`,
  ),
  exactClause(
    "successor plan operator order starts exact READ COMMITTED then uses fresh post-gate query",
    `Execute exactly BEGIN ISOLATION LEVEL READ COMMITTED, then
    SET LOCAL search_path = pg_catalog, before any other query. Call fixed
    dasher_retention_api.initialize_operator_context(...) with typed
    target_dashboard_id, bounded request/case values, and the exact capability
    required by the immediately following fixed operation as the first authority
    operation.`,
  ),
  exactClause(
    "successor plan writer-first visibility and stronger isolation denial",
    `Writer-first means the disabling writer commits its new latest revision before
    releasing the gate; the waiting READ COMMITTED initializer acquires next, and
    its distinct VOLATILE post-gate query sees latest-disabled and denies without
    fallback. Initializer-first means it reads/binds the prior latest revision and
    holds the gate through transaction end, so the writer waits and that old
    authority is valid only for the already-winning transaction. Explicit
    REPEATABLE READ and SERIALIZABLE calls deny before allowlist authority access.`,
  ),
  exactClause(
    "successor plan provisional target-discovery context is bounded",
    `It then writes private provisional transaction-local context with
    only bootstrap phase target_discovery, validated principal ID/revision/scope,
    the exact required capability, bounded request/case values, and the supplied
    target_dashboard_id. It does not set an authorized target organization.`,
  ),
  exactClause(
    "successor plan target discovery is single-row non-locking and non-observable",
    `Exactly one pre-full-context target-discovery forced-RLS policy exists on
    dasher.dashboards. It permits the retention definer to SELECT only the
    single row whose dashboard_id equals the provisional context's
    target_dashboard_id, and only while current user, bootstrap phase, validated
    principal/revision/scope/capability, and the gate-stabilized selected allowlist
    binding all match.
    The initializer projects only organization_id internally, takes no tenant row
    lock during discovery, exposes no row/count/existence result, and normalizes
    missing, forged, cross-tenant, and unauthorized locators to the same denial.`,
  ),
  exactClause(
    "successor plan triggers use implementable row and context predicates",
    `Immutability/purge triggers do not
    inspect or claim to recognize a call stack. They require exact
    current_user = dasher_retention_definer, full phase authorized, the locked
    operator principal/revision/capability, exact target organization/dashboard,
    an allowed OLD to NEW transition, the expected lifecycle revision, and an
    exact column-delta allowlist. If OLD/NEW plus context cannot distinguish an
    authorized transition, the trigger denies it.`,
  ),
  exactClause(
    "successor plan app initializer retains immutable 0002 lock order",
    `Call existing dasher_api.initialize_context(...) in that same transaction.
    The immutable 0002 initializer derives the organization, acquires and
    continues to hold its organization advisory transaction gate, locks
    membership and then session in that order, and validates session time
    internally. 0003 does not reacquire or reorder those locks.`,
  ),
  exactClause(
    "successor plan full context follows derived organization gate and disables discovery",
    `It then acquires
    the derived target-organization advisory transaction gate before any tenant row
    lock and replaces provisional context with full phase authorized, binding the
    target organization and exact target dashboard in addition to the validated
    principal/revision/capability/request/case values. The target-discovery policy
    no longer matches after that phase change. With both advisory gates held, the
    initializer locks and revalidates the same dashboard through the ordinary
    full-context forced-RLS policy. Any mismatch raises, rolls back the transaction,
    and clears all transaction-local state.`,
  ),
  exactClause(
    "successor plan has tenant-keyed dashboard tombstones",
    `dasher.dashboard_tombstones is tenant-keyed by
    (organization_id, tombstone_lineage_id). Revocation creates the row exactly
    once from the dashboard's own opaque random lineage ID.`,
  ),
  exactClause(
    "successor plan has tenant-keyed restore lineage",
    `dasher.dashboard_restore_lineage is append-only and tenant-keyed by the new
    dashboard/version identity. It maps that pair to the source
    tombstone_lineage_id and opaque selected source-version ID, and records the
    policy revision, actor/service authority, database occurrence time, and bounded
    provenance hash.`,
  ),
  exactClause(
    "successor plan has append-only backup deletion ledger",
    `dasher.backup_deletion_ledger is an append-only export seam keyed by
    (organization_id, ledger_sequence), with a gap-free monotonically allocated
    tenant sequence under the organization gate.`,
  ),
  exactClause(
    "successor plan restore creates one parentless durable draft and lineage mapping",
    `In one transaction restore creates a born-durable draft Board with null
    expiry/head, its own new opaque tombstone lineage,
    restored_from_tombstone_lineage_id set to the source lineage, and lifecycle/
    capability/cache values zero. It copies exactly the selected immutable version
    into one new version with no parent, copies only that version's exact snapshot/
    evidence links, creates the new access-bearing claims before source claims can
    later be released, and writes dashboard_restore_lineage with the new IDs,
    source lineage/opaque source-version ID, policy, actor, and database time.`,
  ),
  exactClause(
    "successor plan retention-only claims derive only from legal holds",
    `Retention-only claims originate only in fixed legal-hold placement: under the
    dashboard/resource locks, placement creates one distinct hold-provenanced claim
    per reachable snapshot, evidence record, and artifact. Multiple holds create
    distinct claims. Fixed release removes only claims for that hold after exact
    proof and audit; it cannot touch access-bearing or another hold's claims.`,
  ),
  exactClause(
    "successor plan external backup mechanism remains HOLD",
    `Until it
    exists and passes rehearsal, a restored environment remains isolated, may not
    serve traffic, and cannot count as pilot recovery evidence. The 35-day age-out
    remains a Dasher product/recoverability target, not backup-deletion or provider
    physical-media evidence.`,
  ),
  exactClause(
    "successor plan promotion expiry winner protocol",
    `Promotion and expiry use the same gate and dashboard lock. If promotion locks
    first, it succeeds only when locked database time is < effective_expires_at;
    if expiry locks first or time is exactly the boundary, expiry increments the
    revision and promotion denies as stale/expired.`,
  ),
  exactClause(
    "successor plan hold purge winner protocol",
    `Hold and purge use the same
    gate/revision rule. If hold locks first, purge observes an active hold and does
    nothing; if purge locks first and commits purge_started_at, hold returns
    already_purged without recreation even while finalizers resume. Audit failure
    rolls back whichever lifecycle transition would have won.`,
  ),
  exactClause(
    "successor plan restore remains restore-as-new only",
    `It
    copies no parent DAG, schedule, capability, cache, lease, publication, hold, or
    claim ownership and does not mutate the source/tombstone. It writes fixed
    dashboard.restored_as_new and no revision-zero lifecycle event. A later normal
    validated head CAS activates the restored draft.`,
  ),
  exactClause(
    "successor plan backup resurrection reapplies deletion",
    `Production backup resurrection is fail-closed and on HOLD until a separately
    reviewed operations mechanism exports and independently seals monotonically
    ordered ledger entries newer than every restorable content snapshot.`,
  ),
  exactClause(
    "successor plan replay consumes recorded results without redispatch",
    `Deterministic orchestration does not promise deterministic model output. Replay
    walks append-only ordered events and consumes immutable recorded model/tool
    results; it never calls a model or tool again expecting an identical answer. A
    new call is a new metered attempt or new run.`,
  ),
  exactClause(
    "successor plan lease epoch fences every write path",
    `Every worker acquisition atomically increments a monotonic lease_epoch; a TTL
    lease alone is not a fence. Every event/result/checkpoint, artifact/head/cache
    commit, budget reserve/reconcile/release, and outbox dispatch supplies and
    atomically revalidates the current epoch.`,
  ),
  exactClause(
    "successor plan paid-call reservation and billing quarantine",
    `Before any paid/external call, one fenced transaction resolves exact provider/
    model and versioned price-book digests, conservatively estimates worst case,
    reserves every relevant counter, appends attempt_reserved, and commits. Only
    then may the outbox/provider dispatcher run. Response and usage are persisted,
    then a fenced transaction reconciles reserved capacity into used and released
    counters. Unknown price or token estimation denies. A timeout after dispatch is
    billing-indeterminate and retains its reservation until provider reconciliation
    or explicit quarantine-expiry/operator policy.`,
  ),
  exactClause(
    "successor plan strict discriminated typed JSON AST",
    `The implementation is a strict discriminated JSON AST inspired by CEL typing,
    not unrestricted CEL or JSON Logic source. Each operation has one JSON Schema
    2020-12 schema with required fields and additionalProperties: false. Unknown
    operation/key/schema-version/registry-version/field/literal fails.`,
  ),
  exactClause(
    "successor plan expression execution is closed",
    `There is no general reduce, unrestricted distinct, code, SQL, regex, dynamic
    path/function, implicit join, recursion, or unbounded cardinality.`,
  ),
  exactClause(
    "successor plan expression static and runtime bounds",
    `Hard declared caps cover source/AST bytes, nodes/depth, literals/list lengths,
    scanned rows, groups/group size, intermediate/output bytes/cardinality,
    evaluator steps, wall time, and memory. Static type/unit/cost/cardinality
    analysis precedes execution and runtime metering enforces the same limits.`,
  ),
  exactClause(
    "successor plan passwordless forward migration and stable identity",
    `### Passwordless is a separate forward migration

    The later identity plan uses a built-in issuer with opaque stable subject and
    email only as verified delivery binding.`,
  ),
  exactClause(
    "successor plan email never links and passwordless stays out of 0003",
    `Matching email
    never links identities. External-IdP-required organizations fail closed.
    Sensitive admin authentication age is at most 15 minutes; existing session
    limits stay 30-minute idle and 7-day absolute. None of this belongs in 0003.`,
  ),
];

const foundationClauseContracts: DocumentClauseContract[] = [
  {
    label: "PRODUCT_REQUIREMENTS",
    document: productRequirements,
    clauses: productRequirementClauses,
  },
  { label: "ADR-003", document: adr003, clauses: adr003Clauses },
  { label: "ADR-004", document: adr004, clauses: adr004Clauses },
  { label: "ADR-005", document: adr005, clauses: adr005Clauses },
  {
    label: "HISTORICAL_PRODUCT_SPINE",
    document: historicalProductSpine,
    clauses: historicalProductSpineClauses,
  },
  {
    label: "DASHBOARD_LIFECYCLE_SUCCESSOR_PLAN",
    document: dashboardLifecyclePlan,
    clauses: dashboardLifecyclePlanClauses,
  },
];

const expectedValidationAgentRows = [
  [
    "A01",
    "County emergency-management director",
    "`claude-fable-5`",
    "changed",
    "PASS",
    "2",
    "1",
    "MISS",
    "4",
    "missing-context",
    "More historical comparison",
  ],
  [
    "A02",
    "Regional water-utility operations manager",
    "`claude-opus-5`",
    "next-action",
    "PASS",
    "2",
    "1",
    "MISS",
    "4",
    "unclear, missing-context",
    "Clearer alert thresholds",
  ],
  [
    "A03",
    "City manager and executive generalist",
    "`claude-sonnet-5`",
    "changed",
    "PASS",
    "2",
    "1",
    "PASS",
    "4",
    "missing-context",
    "Named owner or handoff",
  ],
  [
    "A04",
    "Watershed nonprofit executive director",
    "`claude-haiku-4-5-20251001`",
    "next-action",
    "PASS",
    "2",
    "1",
    "PASS",
    "4",
    "missing-context",
    "Named owner or handoff",
  ],
  [
    "A05",
    "Private-company COO",
    "`gpt-5.6-sol`",
    "changed",
    "PASS",
    "1",
    "1",
    "PASS",
    "4",
    "missing-context",
    "Named owner or handoff",
  ],
  [
    "A06",
    "Elected county supervisor",
    "`gpt-5.6-luna`",
    "next-action",
    "PASS",
    "1",
    "1",
    "PASS",
    "4",
    "missing-context",
    "Named owner or handoff",
  ],
] as const;

const expectedRehearsalAgentRows = expectedValidationAgentRows;

function parseAgentRows(document: string): string[][] {
  return document
    .split("\n")
    .filter((line) => /^\|\s*A\d+\s*\|/.test(line))
    .map((line) =>
      line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim()),
    );
}

const allowedFeedbackFlags = new Set([
  "wrong",
  "unclear",
  "missing-context",
  "none",
]);

function deriveAgentResults(rows: string[][]) {
  const total = rows.length;
  const usefulnessScore = Number(rows[0]?.[8]);
  return {
    content: [rows.filter((row) => row[4] === "PASS").length, total] as [
      number,
      number,
    ],
    evidence: [rows.filter((row) => Number(row[5]) <= 2).length, total] as [
      number,
      number,
    ],
    mechanical: [rows.filter((row) => row[6] === "1").length, total] as [
      number,
      number,
    ],
    strictTypes: [rows.filter((row) => row[7] === "PASS").length, total] as [
      number,
      number,
    ],
    boundedFeedback: [
      rows.filter(
        (row) =>
          Number(row[8]) >= 1 &&
          Number(row[8]) <= 5 &&
          (row[9] ?? "")
            .split(",")
            .map((flag) => flag.trim())
            .every((flag) => allowedFeedbackFlags.has(flag)) &&
          row[10] !== undefined &&
          row[10].length > 0,
      ).length,
      total,
    ] as [number, number],
    namedOwnerNeed: [
      rows.filter((row) => row[10] === "Named owner or handoff").length,
      total,
    ] as [number, number],
    usefulnessScore: [usefulnessScore, 5] as [number, number],
    distinctModels: new Set(rows.map((row) => row[2])).size,
    changedTargets: rows.filter((row) => row[3] === "changed").length,
    nextActionTargets: rows.filter((row) => row[3] === "next-action").length,
    allowedFeedback: rows.every(
      (row) =>
        Number(row[8]) === usefulnessScore &&
        (row[9] ?? "")
          .split(",")
          .map((flag) => flag.trim())
          .every((flag) => allowedFeedbackFlags.has(flag)),
    ),
  };
}

function mutateAgentCell(
  document: string,
  id: string,
  columnIndex: number,
  replacement: string,
): string {
  let changed = false;
  const result = document
    .split("\n")
    .map((line) => {
      if (!new RegExp(`^\\|\\s*${id}\\s*\\|`).test(line)) return line;
      const cells = line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim());
      cells[columnIndex] = replacement;
      changed = true;
      return `| ${cells.join(" | ")} |`;
    })
    .join("\n");
  if (!changed) throw new Error(`missing agent row ${id}`);
  return result;
}

function parseBoldAggregate(document: string, label: string): [number, number] {
  const line = document
    .split("\n")
    .find((candidate) => candidate.startsWith(`- ${label}: **`));
  const match = line?.match(/\*\*(\d+) of (\d+)\*\*/);
  if (!match?.[1] || !match[2]) throw new Error(`missing aggregate ${label}`);
  return [Number(match[1]), Number(match[2])];
}

function parseFraction(value: string, label: string): [number, number] {
  const match = value.match(/^(\d+)\/(\d+)$/);
  if (!match?.[1] || !match[2]) throw new Error(`missing fraction ${label}`);
  return [Number(match[1]), Number(match[2])];
}

function parseTableMeasure(document: string, label: string) {
  const line = document
    .split("\n")
    .find((candidate) => candidate.startsWith(`| ${label}`));
  const cells = line
    ?.split("|")
    .slice(1, -1)
    .map((cell) => cell.trim());
  const result = cells?.[1];
  const threshold = cells?.[2];
  if (!result || !threshold) throw new Error(`missing table measure ${label}`);
  return {
    result: parseFraction(result, `${label} result`),
    threshold:
      threshold === "n/a"
        ? null
        : parseFraction(threshold, `${label} threshold`),
  };
}

function parseTableAggregate(
  document: string,
  label: string,
): [number, number] {
  return parseTableMeasure(document, label).result;
}

function parseRehearsalThresholdNarrative(
  document: string,
): Map<string, [number, number] | null> {
  const match = document.match(
    /owner-approved synthetic thresholds are (\d+)\/(\d+) for four-part content, (\d+)\/(\d+) for\s+predicted evidence reachability, (\d+)\/(\d+) for mechanical replay, (\d+)\/(\d+) for strict\s+displayed types, and (\d+)\/(\d+) for bounded usefulness and need/,
  );
  if (!match || match.slice(1).some((value) => value === undefined)) {
    throw new Error("missing rehearsal threshold narrative");
  }
  return new Map<string, [number, number] | null>([
    ["Four-part content recovered", [Number(match[1]), Number(match[2])]],
    [
      "Predicted evidence path within two interactions",
      [Number(match[3]), Number(match[4])],
    ],
    [
      "Chosen evidence path mechanically opened",
      [Number(match[5]), Number(match[6])],
    ],
    [
      "Strict displayed statement-type mapping",
      [Number(match[7]), Number(match[8])],
    ],
    [
      "Bounded usefulness and need supplied",
      [Number(match[9]), Number(match[10])],
    ],
  ]);
}

function parseRatio(
  document: string,
  pattern: RegExp,
  label: string,
): [number, number] {
  const match = document.match(pattern);
  if (!match?.[1] || !match[2]) throw new Error(`missing ratio ${label}`);
  return [Number(match[1]), Number(match[2])];
}

function parseStimulusHashes(document: string): [string, string] {
  const head = document.match(
    /(?:Rehearsal stimulus HEAD:|dashboard HEAD)\s*`([a-f0-9]{40})`/,
  )?.[1];
  const tree = document.match(
    /(?:Rehearsal stimulus tree:|, tree)\s*`([a-f0-9]{40})`/,
  )?.[1];
  if (!head || !tree) throw new Error("missing rehearsal stimulus hashes");
  return [head, tree];
}

function extractSection(
  document: string,
  startHeading: string,
  endHeading: string,
): string {
  const start = document.indexOf(startHeading);
  const end = document.indexOf(endHeading, start + startHeading.length);
  if (start < 0 || end < 0) throw new Error(`missing section ${startHeading}`);
  return document.slice(start, end);
}

const humanResultSubject =
  /\b(?:human(?: participants?| sessions?| users?)|humans?|human-equivalent(?: participants?| sessions?| users?)?|real[- ](?:person|human|user)s?|participants?|manager-shaped users?)\b/i;
const positiveHumanResult =
  /\b(?:pass(?:ed|es)?|validat(?:e|ed|es|ion)|prov(?:e|ed|en)|succeed(?:ed|s)?|complet(?:ed|es)|met|achiev(?:e|ed|es)|conduct(?:ed|s)?|test(?:ed|s)?|interview(?:ed|s)?|enroll(?:ed|s)?|includ(?:ed|es)?|participat(?:ed|es)?|occur(?:red|s)?|happen(?:ed|s)?|perform(?:ed|s)?|count(?:ed|s)?)\b/i;

function hasSubjectScopedNegation(claim: string): boolean {
  const subject = humanResultSubject.exec(claim);
  if (!subject || subject.index === undefined) return false;
  const before = claim.slice(Math.max(0, subject.index - 80), subject.index);
  const after = claim.slice(
    subject.index + subject[0].length,
    subject.index + 100,
  );
  const negationBefore =
    /(?:\bno|\bzero|\bnot one|\bnone(?: of the)?)\s+(?:[\w-]+\s+){0,4}$/i.test(
      before,
    ) ||
    /\b(?:do|does|did|can|must|is|are|was|were)\s+not\s+(?:[\w-]+\s+){0,8}$/i.test(
      before,
    );
  const negationAfter =
    /^\s+(?:(?:did|does|do|was|were|is|are|has|have|had|must|can)\s+not|never|cannot)\b/i.test(
      after,
    );
  const laterPositiveResult = /\b(?:and|but|however|yet)\b/i.test(after)
    ? positiveHumanResult.test(
        after.slice(after.search(/\b(?:and|but|however|yet)\b/i)),
      )
    : false;
  return negationBefore || (negationAfter && !laterPositiveResult);
}

function findFabricatedHumanClaims(document: string): string[] {
  return document
    .replace(/`[^`]*`/g, "")
    .replace(/\n+/g, " ")
    .split(
      /(?<=[.!?;])\s+|,\s*(?:and|but|however|yet)\s+|\s+(?:but|however|yet)\s+/i,
    )
    .map((claim) => claim.trim())
    .filter(
      (claim) =>
        ((humanResultSubject.test(claim) && positiveHumanResult.test(claim)) ||
          /\bresults?\s+(?:are|were)\s+human-equivalent\b/i.test(claim)) &&
        !hasSubjectScopedNegation(claim),
    );
}

const syntheticClaimDocuments = [
  readme,
  extractSection(roadmap, "## Gate 1", "## Gate 2"),
  extractSection(
    plan,
    "## Post-implementation governance amendment",
    "## Hard boundaries",
  ),
  validation,
  rehearsal,
];

const roadmapClauses: Clause[] = [
  {
    label: "roadmap accepted synthetic status",
    pattern: /^Status: ACCEPTED — OWNER-ACCEPTED SYNTHETIC VALIDATION$/m,
  },
  {
    label: "roadmap no human-equivalent claim",
    pattern:
      /No human\s+sessions were conducted, no agent is represented as a human equivalent, and the\s+accepted result does not establish 30-second human comprehension or physical\s+interaction usability\./,
  },
  {
    label: "roadmap synthetic content 6/6",
    pattern:
      /- All 6 of 6 synthetic structured answers recovered the intended Known,\s+Changed, Important, and Next safe action content\./,
  },
  {
    label: "roadmap synthetic evidence 6/6 and replay",
    pattern:
      /- All 6 of 6 selected the requested evidence control and predicted no more than\s+two interactions; isolated Playwright replay opened every selected target in\s+one automated activation\./,
  },
  {
    label: "roadmap evidence integrity and freshness",
    pattern:
      /- Every visible factual or calculated claim resolves to valid evidence; stale\s+or missing data is not presented as fresh\./,
  },
  {
    label: "roadmap strict statement types 4/6",
    pattern:
      /- Exactly 4 of 6 reproduced the displayed source-fact, deterministic-\s+calculation, interpretation, and recommendation mapping without adding a\s+secondary type\./,
  },
  {
    label: "roadmap bounded feedback 6/6",
    pattern:
      /- All 6 of 6 supplied a bounded usefulness rating and one bounded missing-\s+information or workflow-need category\./,
  },
  {
    label: "roadmap explicit owner acceptance",
    pattern:
      /- The owner reviewed the dashboard and explicitly accepted the synthetic result\s+as the Gate 1 product decision\./,
  },
  {
    label: "roadmap Gate 4 retains real-user benchmark",
    pattern:
      /- On the file-generated dashboard, at least 5 of 6 manager-shaped users identify\s+Known, Changed, Important, and Next safe action within 30 seconds, and\s+independently at least 5 of 6 reach requested evidence within two interactions\./,
  },
  {
    label: "roadmap Gate 7 continues Gate 4 real-user goals",
    pattern:
      /- The Gate 4 real-user 30-second comprehension and two-interaction evidence\s+goals continue to pass on pilot dashboards\./,
  },
  {
    label: "roadmap Gate 2 forced tenant isolation",
    pattern:
      /Implement ADR-003 before accepting any real customer data: invitations,\s+sessions, organizations, roles, PostgreSQL `FORCE ROW LEVEL SECURITY`,\s+composite tenant-safe foreign keys, immutable sources\/evidence\/dashboard\s+versions\/job events\/audit, tenant-scoped object storage, revocation, limits,\s+backup\/restore, kill switches, and incident controls\./,
  },
  {
    label: "roadmap Gate 2 cross-tenant denial and fail-closed context",
    pattern:
      /- Cross-tenant read, count, update, delete, reference, enqueue, storage, signed\s+URL, job, evidence, and cache tests deny access under restricted runtime\s+roles with forced RLS\.\s+- Forged or missing tenant context, pooled-connection reuse, composite-FK\s+violations, and membership revocation races fail closed\./,
  },
  {
    label: "roadmap Gate 3 pre-parse raw-byte and network controls",
    pattern:
      /proof\. It must use exact approved hosts and parameters, early raw-response byte\s+limits before parsing, SSRF\/redirect\/time\/decompression controls, snapshot\s+ceilings as defense in depth, bounded retries, reauthorization, and prior-good\s+version preservation\./,
  },
  {
    label: "roadmap Gate 3 raw bytes before object construction",
    pattern:
      /- Raw connector bytes are limited before object construction or parsing; the\s+existing object snapshot and schema budgets still apply afterward\./,
  },
  {
    label: "roadmap Gate 4 upload and parser controls",
    pattern:
      /Uploads enforce raw body and object bytes before parsing, quarantine,\s+tenant-scoped storage, parser isolation, decompression\/workbook complexity\s+limits, and macro, external-link, embedded-object, formula-execution, and\s+formula-injection controls\./,
  },
  {
    label: "roadmap Gate 4 deterministic evidence",
    pattern:
      /All displayed cash-flow metrics are computed by\s+deterministic services and retain workbook, sheet, range, transformation, and\s+time-window evidence\./,
  },
  {
    label: "roadmap Gate 5 zero-call fake provider",
    pattern:
      /- Fake-provider mode exercises the full request and validation path with zero\s+network and zero credential access\./,
  },
  {
    label: "roadmap Gate 5 reject unsafe provider requests before transport",
    pattern:
      /- Provider tools, arbitrary compatible base URLs, unsupported plan\s+credentials, cross-tenant fallback, and requests beyond budget are rejected\s+before transport\./,
  },
  {
    label: "roadmap Gate 5 invalid candidates fail closed",
    pattern:
      /- Invalid `DashboardSpec`, invented or cross-tenant evidence, unsupported\s+calculations, unsafe URLs, non-finite values, and unknown components cannot\s+create a candidate\./,
  },
  {
    label: "roadmap Gate 6 read-only authority boundary",
    pattern:
      /administrator-approved, exact-manifest-pinned, read-only, per-user authorized,\s+resource\/audience-bound, no token passthrough, no sampling or server-initiated\s+model calls, and no transitive action\/Gmail\/Calendar\/Drive-sharing authority\./,
  },
  {
    label: "roadmap Gate 6 no side-effect tools",
    pattern:
      /- A side-effect tool cannot be enabled by configuration or model output\./,
  },
  {
    label: "roadmap Gate 7 exact-deployment entry requirements",
    pattern:
      /- Gates 0 through 5 pass on the exact deployment\. Gate 6 also passes before any\s+Google Sheets or MCP capability is offered\./,
  },
  {
    label: "roadmap Gate 7 owner go-no-go and drills",
    pattern:
      /- The owner records the permitted real-data classes and data-processing terms,\s+named pilot cohort and accepted use cases, liability boundary, and explicit\s+private-pilot go\/no-go decision\.\s+- Restore, credential rotation, revocation, provider\/schedule kill switches,\s+audit sealing, monitoring, rollback, and incident-response drills pass\./,
  },
  {
    label: "roadmap Gate 7 no unresolved isolation blockers",
    pattern:
      /- No unresolved tenant-isolation, secret-handling, ingestion, or authority-race\s+blocker remains\./,
  },
];

const planClauses: Clause[] = [
  {
    label: "plan accepted synthetic amendment",
    pattern:
      /## Post-implementation governance amendment\s+Status: ACCEPTED — OWNER-ACCEPTED SYNTHETIC VALIDATION/,
  },
  {
    label: "plan owner replaced real-person gate",
    pattern:
      /explicitly replaced the plan's previously required\s+six-real-person Gate 1 with an owner-accepted synthetic product gate\./,
  },
  {
    label: "plan honest provider diversity",
    pattern:
      /The six\s+model IDs are distinct, but provider diversity is not six-way: four are\s+Claude-family models and two are OpenAI models run through Codex\./,
  },
  {
    label: "plan no human-equivalent claim",
    pattern:
      /No human sessions were performed, no synthetic agent is\s+recorded as a human equivalent, and no 30-second human-comprehension claim is\s+made\./,
  },
  {
    label: "plan retained synthetic metrics",
    pattern:
      /6-of-6 content recovery, 6-of-6\s+predicted evidence reachability, 6-of-6 mechanically valid one-activation paths,\s+4-of-6 strict statement-type mapping, and bounded usefulness\/need feedback from\s+all six\./,
  },
  {
    label: "plan later gates remain independent",
    pattern:
      /Later roadmap gates retain their independent security, real-data,\s+manager-user, and release requirements\./,
  },
];

const validationClauses: Clause[] = [
  {
    label: "validation accepted synthetic status",
    pattern: /^Status: ACCEPTED — OWNER-ACCEPTED SYNTHETIC VALIDATION$/m,
  },
  {
    label: "validation explicit gate replacement",
    pattern:
      /replaced the previously planned six-real-person gate with the bounded\s+six-agent rehearsal recorded below\./,
  },
  {
    label: "validation no human-equivalent claim",
    pattern:
      /No real-human usability sessions were conducted\. The agents are not represented\s+as humans or human-equivalent research participants\./,
  },
  {
    label: "validation exact rehearsal stimulus",
    pattern:
      /- Rehearsal stimulus HEAD: `9a8ef6d2dd53156c46118d8d71154d780b0b9c04`\s+- Rehearsal stimulus tree: `76c3e0fe825217479b8876dbb63fc61e0e34329b`/,
  },
  {
    label: "validation stimulus is not containing commit",
    pattern:
      /The hashes above identify the exact dashboard shown during the rehearsal; they\s+do not claim to identify the later commit that contains this governance record\.\s+The containing commit is identified externally by Git, CI, and exact-head review\s+because a commit cannot include its own final hash\./,
  },
  {
    label: "validation distinct isolated models",
    pattern:
      /- Isolation: six one-shot multimodal sessions with distinct model IDs, system\s+prompts, and manager\/community-leader personas\. Answers were not shared\./,
  },
  ...modelClauses("validation"),
  {
    label: "validation synthetic content 6/6",
    pattern:
      /- all six structured answers recovered the intended Known, Changed, Important,\s+and Next safe action content;/,
  },
  {
    label: "validation synthetic evidence and replay 6/6",
    pattern:
      /- all six selected the evidence control for the requested target and predicted\s+no more than two interactions;\s+- all six selected paths were mechanically verified to open the requested\s+evidence in one automated activation;/,
  },
  {
    label: "validation strict statement types 4/6",
    pattern:
      /- four of six reproduced the displayed statement-type mapping exactly;/,
  },
  {
    label: "validation all-six bounded feedback",
    pattern:
      /- all six supplied a bounded usefulness rating and one bounded need category;/,
  },
  {
    label: "validation owner decision",
    pattern:
      /Aggregate result: ACCEPTED — owner-accepted synthetic Gate 1\. No human sessions\s+were performed or counted, and no claim of human-equivalent validation is made\./,
  },
];

const rehearsalClauses: Clause[] = [
  {
    label: "rehearsal synthetic status",
    pattern: /^Status: ACCEPTED AS SYNTHETIC GATE EVIDENCE$/m,
  },
  {
    label: "rehearsal not human research",
    pattern:
      /This is a synthetic model rehearsal, not human research[\s\S]*must not be described\s+as human-equivalent validation\./,
  },
  {
    label: "rehearsal exact stimulus",
    pattern:
      /dashboard HEAD\s+`9a8ef6d2dd53156c46118d8d71154d780b0b9c04`, tree\s+`76c3e0fe825217479b8876dbb63fc61e0e34329b`/,
  },
  ...modelClauses("rehearsal"),
  {
    label: "rehearsal honest provider diversity",
    pattern:
      /The six model IDs are distinct\. Provider diversity is not six-way: four are\s+Claude-family models and two are OpenAI models run through Codex\./,
  },
  {
    label: "rehearsal explicit thresholds",
    pattern:
      /The owner-approved synthetic thresholds are 5\/6 for four-part content, 5\/6 for\s+predicted evidence reachability, 6\/6 for mechanical replay, 4\/6 for strict\s+displayed types, and 6\/6 for bounded usefulness and need\./,
  },
  {
    label: "rehearsal aggregate content 6/6",
    pattern: /\|\s*Four-part content recovered\s*\|\s*6\/6\s*\|\s*5\/6\s*\|/,
  },
  {
    label: "rehearsal aggregate evidence 6/6",
    pattern:
      /\|\s*Predicted evidence path within two interactions\s*\|\s*6\/6\s*\|\s*5\/6\s*\|/,
  },
  {
    label: "rehearsal aggregate strict types 4/6",
    pattern:
      /\|\s*Strict displayed statement-type mapping\s*\|\s*4\/6\s*\|\s*4\/6\s*\|/,
  },
  {
    label: "rehearsal aggregate mechanical 6/6",
    pattern:
      /\|\s*Chosen evidence path mechanically opened\s*\|\s*6\/6\s*\|\s*6\/6\s*\|/,
  },
  {
    label: "rehearsal aggregate bounded feedback 6/6",
    pattern:
      /\|\s*Bounded usefulness and need supplied\s*\|\s*6\/6\s*\|\s*6\/6\s*\|/,
  },
  {
    label: "rehearsal owner decision without human claim",
    pattern:
      /explicitly replaced\s+the previously planned real-person Gate 1 with this owner-accepted synthetic\s+product gate\. No agent was entered as a human participant, and no human usability\s+claim is made\./,
  },
];

function missingClauses(document: string, clauses: Clause[]): string[] {
  return clauses
    .filter(({ pattern }) => !pattern.test(document))
    .map(({ label }) => label);
}

function missingReadmeClauses(document: string): string[] {
  return missingExactClauses(document, readmeClauses);
}

function missingExactClauses(
  document: string,
  clauses: ExactClause[],
): string[] {
  const normalizedDocument = normalizeClauseText(document);
  return clauses
    .filter(({ text }) => !normalizedDocument.includes(text))
    .map(({ label }) => label);
}

describe("owner-accepted synthetic Gate 1 documentation contract", () => {
  it("locks the README summary without fabricating human validation", () => {
    const normalizedReadme = normalizeClauseText(readme);
    expect(missingReadmeClauses(readme)).toEqual([]);
    expect(new Set(readmeClauses.map(({ label }) => label)).size).toBe(
      readmeClauses.length,
    );
    expect(new Set(readmeClauses.map(({ text }) => text)).size).toBe(
      readmeClauses.length,
    );

    for (const clause of readmeClauses) {
      expect(normalizedReadme.split(clause.text)).toHaveLength(2);
      const removed = replaceOccurrence(
        normalizedReadme,
        clause.text,
        1,
        `[REMOVED ${clause.label}]`,
      );
      expect(missingReadmeClauses(removed)).toContain(clause.label);

      const altered = replaceOccurrence(
        normalizedReadme,
        clause.text,
        1,
        clause.text.replace(/[A-Za-z0-9]/, "_"),
      );
      expect(missingReadmeClauses(altered)).toContain(clause.label);
    }
  });

  it("locks the roadmap decision, synthetic evidence, and retained boundaries", () => {
    expect(missingClauses(roadmap, roadmapClauses)).toEqual([]);
  });

  it.each(foundationClauseContracts)(
    "locks and independently mutation-tests $label safety clauses",
    ({ document, clauses }) => {
      const normalizedDocument = normalizeClauseText(document);
      expect(clauses).not.toHaveLength(0);
      expect(new Set(clauses.map(({ label }) => label)).size).toBe(
        clauses.length,
      );
      expect(new Set(clauses.map(({ text }) => text)).size).toBe(
        clauses.length,
      );
      expect(missingExactClauses(normalizedDocument, clauses)).toEqual([]);

      for (const clause of clauses) {
        expect(normalizedDocument.split(clause.text)).toHaveLength(2);

        const removed = replaceOccurrence(
          normalizedDocument,
          clause.text,
          1,
          `[REMOVED ${clause.label}]`,
        );
        expect(missingExactClauses(removed, clauses)).toContain(clause.label);

        const alteredText = clause.text.replace(/[A-Za-z0-9]/, "_");
        const altered = replaceOccurrence(
          normalizedDocument,
          clause.text,
          1,
          alteredText,
        );
        expect(missingExactClauses(altered, clauses)).toContain(clause.label);
      }
    },
  );

  it("locks and independently mutation-tests every Gate 2–7 block", () => {
    const actual = parseRoadmapGateBoundaries(roadmap);
    expect(actual).toHaveLength(69);
    expect(actual).toEqual(expectedRoadmapGateBoundaries);
    expect(new Set(actual.map(({ key }) => key)).size).toBe(actual.length);

    const normalizedRoadmap = normalizeWhitespace(
      extractSection(roadmap, "## Gate 2", "## Explicit deferrals"),
    );
    const seenTexts = new Map<string, number>();
    for (const boundary of expectedRoadmapGateBoundaries) {
      const totalOccurrences = expectedRoadmapGateBoundaries.filter(
        ({ text }) => text === boundary.text,
      ).length;
      expect(normalizedRoadmap.split(boundary.text)).toHaveLength(
        totalOccurrences + 1,
      );
      const occurrence = (seenTexts.get(boundary.text) ?? 0) + 1;
      seenTexts.set(boundary.text, occurrence);
      const mutated = replaceOccurrence(
        normalizedRoadmap,
        boundary.text,
        occurrence,
        `[REMOVED ${boundary.key}]`,
      );
      expect(mutated).not.toBe(normalizedRoadmap);
      expect(mutated.split(boundary.text)).toHaveLength(totalOccurrences);

      const alteredText = boundary.text.replace(/[A-Za-z0-9]/, "_");
      const altered = replaceOccurrence(
        normalizedRoadmap,
        boundary.text,
        occurrence,
        alteredText,
      );
      expect(altered).not.toBe(normalizedRoadmap);
      expect(altered.split(boundary.text)).toHaveLength(totalOccurrences);
    }
  });

  it("locks the post-implementation governance amendment", () => {
    expect(missingClauses(plan, planClauses)).toEqual([]);
  });

  it("locks the accepted record without fabricating human validation", () => {
    expect(missingClauses(validation, validationClauses)).toEqual([]);
  });

  it("locks six distinct model records and aggregate rehearsal outcomes", () => {
    expect(missingClauses(rehearsal, rehearsalClauses)).toEqual([]);
  });

  it("cross-locks the stimulus hashes and rejects additive human fabrication", () => {
    const stimulusHashes = parseStimulusHashes(validation);
    expect(parseStimulusHashes(rehearsal)).toEqual(stimulusHashes);
    for (const document of [validation, rehearsal]) {
      for (const hash of stimulusHashes) {
        expect(document.split(`\`${hash}\``)).toHaveLength(2);
      }
    }
    for (const document of syntheticClaimDocuments) {
      expect(findFabricatedHumanClaims(document)).toEqual([]);
    }

    for (const fabricated of [
      "Seven human participants passed the study.",
      "The dashboard passed validation with six real users.",
      "The study included human participants.",
      "Results are human-equivalent.",
      "Six human sessions occurred.",
      "Seven human participants passed the study with no coaching.",
      "No synthetic agents passed, and seven human participants passed the study.",
      "Seven humans passed with no coaching.",
      "No synthetic agents passed, and seven humans passed.",
      "Seven human participants did not receive coaching and passed.",
    ]) {
      expect(findFabricatedHumanClaims(fabricated)).not.toEqual([]);
    }
    for (const honestNegation of [
      "No human sessions occurred.",
      "Human sessions did not occur.",
      "None of the human participants passed the study.",
      "None participants passed.",
    ]) {
      expect(findFabricatedHumanClaims(honestNegation)).toEqual([]);
    }
  });

  it("locks every per-agent result and derives each record independently", () => {
    const validationRows = parseAgentRows(validation);
    const rehearsalRows = parseAgentRows(rehearsal);
    const validationDerived = deriveAgentResults(validationRows);
    const rehearsalDerived = deriveAgentResults(rehearsalRows);

    expect(validationRows).toEqual(expectedValidationAgentRows);
    expect(rehearsalRows).toEqual(expectedRehearsalAgentRows);
    expect(rehearsalRows).toEqual(validationRows);
    expect(rehearsalDerived).toEqual(validationDerived);
    expect(validationDerived.distinctModels).toBe(6);
    expect(validationDerived.changedTargets).toBe(3);
    expect(validationDerived.nextActionTargets).toBe(3);
    expect(validationDerived.allowedFeedback).toBe(true);

    const derived = validationDerived;

    expect(
      parseBoldAggregate(validation, "Synthetic four-part content recovery"),
    ).toEqual(derived.content);
    expect(
      parseBoldAggregate(
        validation,
        "Predicted requested-evidence path within two interactions",
      ),
    ).toEqual(derived.evidence);
    expect(
      parseBoldAggregate(
        validation,
        "Mechanically valid requested-evidence path in one activation",
      ),
    ).toEqual(derived.mechanical);
    expect(
      parseBoldAggregate(validation, "Strict displayed statement-type mapping"),
    ).toEqual(derived.strictTypes);
    expect(
      parseBoldAggregate(validation, "Bounded usefulness and need collected"),
    ).toEqual(derived.boundedFeedback);
    expect(parseBoldAggregate(validation, "Repeated need")).toEqual(
      derived.namedOwnerNeed,
    );
    expect(
      parseRatio(
        validation,
        /usefulness was \*\*(\d+) of\s+(\d+)\*\* for every agent/,
        "validation usefulness score",
      ),
    ).toEqual(derived.usefulnessScore);

    expect(
      parseTableAggregate(rehearsal, "Four-part content recovered"),
    ).toEqual(rehearsalDerived.content);
    expect(
      parseTableAggregate(
        rehearsal,
        "Predicted evidence path within two interactions",
      ),
    ).toEqual(rehearsalDerived.evidence);
    expect(
      parseTableAggregate(
        rehearsal,
        "Chosen evidence path mechanically opened",
      ),
    ).toEqual(rehearsalDerived.mechanical);
    expect(
      parseTableAggregate(rehearsal, "Strict displayed statement-type mapping"),
    ).toEqual(rehearsalDerived.strictTypes);
    expect(
      parseTableAggregate(rehearsal, "Bounded usefulness and need supplied"),
    ).toEqual(rehearsalDerived.boundedFeedback);
    expect(
      parseRatio(
        rehearsal,
        /Every model rated the dashboard\s+(\d+)\/(\d+) useful\./,
        "rehearsal usefulness score",
      ),
    ).toEqual(rehearsalDerived.usefulnessScore);
    expect(
      parseRatio(
        rehearsal,
        /\*\*(\d+) of (\d+)\*\* selected `Named owner or handoff`/,
        "rehearsal repeated need",
      ),
    ).toEqual(rehearsalDerived.namedOwnerNeed);

    const expectedThresholds = new Map<string, [number, number] | null>([
      ["Four-part content recovered", [5, 6]],
      ["Predicted evidence path within two interactions", [5, 6]],
      ["Chosen evidence path mechanically opened", [6, 6]],
      ["Strict displayed statement-type mapping", [4, 6]],
      ["Bounded usefulness and need supplied", [6, 6]],
    ]);
    expect(parseRehearsalThresholdNarrative(rehearsal)).toEqual(
      expectedThresholds,
    );
    for (const [label, threshold] of expectedThresholds) {
      expect(rehearsal.split(label)).toHaveLength(2);
      expect(parseTableMeasure(rehearsal, label).threshold).toEqual(threshold);
    }
  });

  it("rejects per-agent and displayed-aggregate mutations", () => {
    const validationCellMutations: Array<[number, string]> = [
      [3, "next-action"],
      [4, "MISS"],
      [5, "99"],
      [6, "99"],
      [7, "PASS"],
      [8, "1"],
      [9, "wrong"],
      [10, "Other bounded need"],
    ];
    for (const [column, replacement] of validationCellMutations) {
      expect(
        parseAgentRows(mutateAgentCell(validation, "A01", column, replacement)),
      ).not.toEqual(expectedValidationAgentRows);
    }
    expect(
      parseAgentRows(mutateAgentCell(rehearsal, "A02", 5, "99")),
    ).not.toEqual(expectedRehearsalAgentRows);

    const a06 = rehearsal
      .split("\n")
      .find((line) => /^\|\s*A06\s*\|/.test(line));
    if (!a06) throw new Error("missing A06 row");
    const extraAgent = `${rehearsal}\n${a06.replace("A06", "A07")}`;
    expect(parseAgentRows(extraAgent)).toHaveLength(7);
    expect(parseAgentRows(extraAgent)).not.toEqual(expectedRehearsalAgentRows);

    const misstatedValidationAggregate = validation.replace(
      "Synthetic four-part content recovery: **6 of 6**",
      "Synthetic four-part content recovery: **5 of 6**",
    );
    expect(
      parseBoldAggregate(
        misstatedValidationAggregate,
        "Synthetic four-part content recovery",
      ),
    ).not.toEqual([6, 6]);

    const misstatedRehearsalAggregate = rehearsal.replace(
      "| Four-part content recovered                     |    6/6 |",
      "| Four-part content recovered                     |    5/6 |",
    );
    expect(
      parseTableAggregate(
        misstatedRehearsalAggregate,
        "Four-part content recovered",
      ),
    ).not.toEqual([6, 6]);

    const misstatedRehearsalThreshold = rehearsal.replace(
      "| Four-part content recovered                     |    6/6 |                 5/6 |",
      "| Four-part content recovered                     |    6/6 |                 4/6 |",
    );
    expect(
      parseTableMeasure(
        misstatedRehearsalThreshold,
        "Four-part content recovered",
      ).threshold,
    ).not.toEqual([5, 6]);
  });

  it("rejects fabricated-human and weakened synthetic-evidence mutations", () => {
    const fabricatedReadmeHumans = readme.replace(
      "No human sessions occurred, the agents are not",
      "Six human-equivalent sessions occurred, and the agents are",
    );
    expect(missingReadmeClauses(fabricatedReadmeHumans)).toContain(
      "README no human-equivalent claim",
    );

    const fabricatedHumans = validation.replace(
      "No real-human usability sessions were conducted. The agents are not represented",
      "Six human-equivalent usability sessions were conducted. The agents are represented",
    );
    expect(missingClauses(fabricatedHumans, validationClauses)).toContain(
      "validation no human-equivalent claim",
    );

    const weakenedRoadmap = roadmap
      .replace(
        "All 6 of 6 synthetic structured answers",
        "Only 5 of 6 synthetic structured answers",
      )
      .replace(
        "All 6 of 6 selected the requested evidence control",
        "Only 5 of 6 selected the requested evidence control",
      )
      .replace("Exactly 4 of 6 reproduced", "Exactly 3 of 6 reproduced")
      .replace("All 6 of 6 supplied", "Only 5 of 6 supplied");
    expect(missingClauses(weakenedRoadmap, roadmapClauses)).toEqual(
      expect.arrayContaining([
        "roadmap synthetic content 6/6",
        "roadmap synthetic evidence 6/6 and replay",
        "roadmap strict statement types 4/6",
        "roadmap bounded feedback 6/6",
      ]),
    );

    const weakenedDownstreamBoundaries: Array<[string, string]> = [
      [
        roadmap.replace(
          "at least 5 of 6 manager-shaped users identify\n  Known, Changed, Important, and Next safe action within 30 seconds",
          "at least 3 of 6 manager-shaped users identify\n  Known, Changed, Important, and Next safe action within 30 seconds",
        ),
        "roadmap Gate 4 retains real-user benchmark",
      ],
      [
        roadmap.replace(
          "The Gate 4 real-user 30-second comprehension and two-interaction evidence",
          "The synthetic Gate 1 comprehension and evidence",
        ),
        "roadmap Gate 7 continues Gate 4 real-user goals",
      ],
      [
        roadmap.replace(
          "PostgreSQL `FORCE ROW LEVEL SECURITY`",
          "PostgreSQL `ROW LEVEL SECURITY`",
        ),
        "roadmap Gate 2 forced tenant isolation",
      ],
      [
        roadmap.replace(
          "Cross-tenant read, count, update, delete, reference, enqueue, storage, signed",
          "Cross-tenant read and update may be allowed",
        ),
        "roadmap Gate 2 cross-tenant denial and fail-closed context",
      ],
      [
        roadmap.replace(
          "exact approved hosts and parameters, early raw-response byte",
          "arbitrary hosts and parameters, late response byte",
        ),
        "roadmap Gate 3 pre-parse raw-byte and network controls",
      ],
      [
        roadmap.replace(
          "Raw connector bytes are limited before object construction or parsing",
          "Raw connector bytes are limited after parsing",
        ),
        "roadmap Gate 3 raw bytes before object construction",
      ],
      [
        roadmap.replace(
          "tenant-scoped storage, parser isolation",
          "shared storage, in-process parsing",
        ),
        "roadmap Gate 4 upload and parser controls",
      ],
      [
        roadmap.replace(
          "All displayed cash-flow metrics are computed by\ndeterministic services",
          "Displayed cash-flow metrics may be generated by\nmodel services",
        ),
        "roadmap Gate 4 deterministic evidence",
      ],
      [
        roadmap.replace(
          "with zero\n  network and zero credential access",
          "with live\n  network and credential access",
        ),
        "roadmap Gate 5 zero-call fake provider",
      ],
      [
        roadmap.replace(
          "requests beyond budget are rejected\n  before transport",
          "requests beyond budget may proceed\n  before review",
        ),
        "roadmap Gate 5 reject unsafe provider requests before transport",
      ],
      [
        roadmap.replace(
          "unknown components cannot\n  create a candidate",
          "unknown components may\n  create a candidate",
        ),
        "roadmap Gate 5 invalid candidates fail closed",
      ],
      [
        roadmap.replace(
          "exact-manifest-pinned, read-only, per-user authorized",
          "unpinned, read-write, shared-account authorized",
        ),
        "roadmap Gate 6 read-only authority boundary",
      ],
      [
        roadmap.replace(
          "A side-effect tool cannot be enabled by configuration or model output",
          "A side-effect tool can be enabled by model output",
        ),
        "roadmap Gate 6 no side-effect tools",
      ],
      [
        roadmap.replace(
          "Gates 0 through 5 pass on the exact deployment",
          "Gates 0 through 5 are planned after deployment",
        ),
        "roadmap Gate 7 exact-deployment entry requirements",
      ],
      [
        roadmap.replace(
          "private-pilot go/no-go decision",
          "automatic private-pilot go decision",
        ),
        "roadmap Gate 7 owner go-no-go and drills",
      ],
      [
        roadmap.replace(
          "No unresolved tenant-isolation, secret-handling, ingestion, or authority-race\n  blocker remains",
          "Known tenant-isolation and authority-race blockers may remain",
        ),
        "roadmap Gate 7 no unresolved isolation blockers",
      ],
    ];
    expect(
      weakenedDownstreamBoundaries.map(([, label]) => label).sort(),
    ).toEqual(
      roadmapClauses
        .filter(({ label }) => /^roadmap Gate [2-7]/.test(label))
        .map(({ label }) => label)
        .sort(),
    );
    for (const [
      mutatedRoadmap,
      expectedMissingClause,
    ] of weakenedDownstreamBoundaries) {
      expect(mutatedRoadmap).not.toBe(roadmap);
      expect(missingClauses(mutatedRoadmap, roadmapClauses)).toContain(
        expectedMissingClause,
      );
    }

    const missingEvidenceIntegrity = roadmap.replace(
      /- Every visible factual or calculated claim resolves to valid evidence; stale\s+  or missing data is not presented as fresh\.\n/,
      "",
    );
    expect(missingClauses(missingEvidenceIntegrity, roadmapClauses)).toContain(
      "roadmap evidence integrity and freshness",
    );

    const missingOwnerDecision = validation.replace(
      /Aggregate result: ACCEPTED — owner-accepted synthetic Gate 1\.[\s\S]*?Gate 2 engineering may begin subject to its own constraints and approvals\./,
      "Aggregate result: PENDING.",
    );
    expect(missingClauses(missingOwnerDecision, validationClauses)).toContain(
      "validation owner decision",
    );

    const missingPlanAmendment = plan.replace(
      "## Post-implementation governance amendment",
      "## Historical note",
    );
    expect(missingClauses(missingPlanAmendment, planClauses)).toContain(
      "plan accepted synthetic amendment",
    );

    const collapsedModelDiversity = rehearsal.replace(
      "`gpt-5.6-luna`",
      "`gpt-5.6-sol`",
    );
    expect(missingClauses(collapsedModelDiversity, rehearsalClauses)).toContain(
      "rehearsal model gpt-5.6-luna",
    );

    const overstatedProviderDiversity = rehearsal.replace(
      "Provider diversity is not six-way: four are",
      "Provider diversity is fully six-way: four are",
    );
    expect(
      missingClauses(overstatedProviderDiversity, rehearsalClauses),
    ).toContain("rehearsal honest provider diversity");
  });
});
