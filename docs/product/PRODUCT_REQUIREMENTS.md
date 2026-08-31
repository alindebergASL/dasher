# Dasher Product Requirements

Status: Approved baseline
Date: 2026-07-29
Updated: 2026-08-01
Domain: `luckbutton.com`
Repository: `alindebergASL/dasher`

> **Amendment accepted (2026-08-31):**
> [Requirements Amendment 01](2026-08-12-requirements-amendment-01.md) now
> governs, recording the owner decisions of 2026-08-12. It replaces the BYOK
> pilot default, replaces the Boards-and-Scratches workspace with one dashboard
> kind and no expiry, adds a provider-evaluation-harness requirement and a
> dashboard-search requirement, and removes the Compose canvas. Superseded
> clauses below are marked in place. The alerting/safety-non-goal pair was
> decided separately — the
> [2026-08-26 decision](2026-08-26-a5-alerting-decision.md) lets the disclaimer
> stand as the boundary, with legal review still owed before a real pilot user
> beyond the owner.

## Product thesis

Dasher is not an AI dashboard generator. It is a governed decision loop that
turns a bounded plain-language intent and authorized evidence into a safe
managerial action and durable decision memory. The loop binds intent, orients,
detects material/new change, explains by epistemic type, proposes a safe action,
preserves the human decision, and promotes reviewed work without widening
authority. The user should not have to define KPIs, choose chart types, or
organize source material before getting a useful evidence-backed view.

## Initial customer

Invite-only pilot for managers and leaders, including CEOs and executive teams. The product is simple by default, with power-user and administrator controls progressively revealed. The data and authorization model must be multi-tenant-ready from the first durable implementation.

## Initial source priority

1. Secure CSV/XLSX upload for customer-owned data, with workbook, sheet, range,
   transformation, and freshness evidence.
2. A controlled USGS live-source proof through the same snapshot, job,
   evidence, and dashboard contracts.
3. A native read-only Google Sheets connector.
4. Broad web research later, with visible citations and claim-level evidence
   reachable within two interactions.
5. Administrator-installed and administrator-approved remote MCP sources only
   after the native connector proves the source contract. Normal users see
   only safe, named, read-only connections.

Later connector targets include Salesforce, HubSpot, Stripe, QuickBooks, Google Analytics, Snowflake, PostgreSQL, Airtable, Notion, and appropriate travel-data services. These are roadmap targets, not MVP scope.

Controlled USGS may precede customer uploads as the first live connector and
job-system proof. CSV/XLSX remains the first customer-owned-data product proof;
broad research and generic connector breadth do not precede it.

## First vertical slice: Local River Conditions

### Example request

> Create a live dashboard monitoring river gauges near Sacramento. Show current water levels and streamflow, which rivers are rising or falling, the gauges changing fastest, recent trends, data freshness, and anything that deserves attention.

### Source

United States Geological Survey river-gauge data. The live adapter must use documented USGS endpoints and retain source URLs, request times, station identifiers, units, and observation timestamps. Development and CI use deterministic fixtures; live calls are explicit integration tests.

### Generated experience

The generated dashboard may have multiple pages and must include:

- Interactive gauge map.
- Current water-level and streamflow cards.
- Rising, falling, and steady classifications.
- One-hour, six-hour, and 24-hour changes.
- Historical trend charts.
- Fastest-rising-gauges ranking.
- User-defined threshold alerts.
- Missing or stale sensor warnings.
- Plain-language conditions summary.
- Filter and drill-down controls appropriate to the data.
- Citation/evidence access for source-derived claims.

### Wow moment

The user states what they want to monitor. Dasher identifies relevant gauges, selects metrics and visualizations, creates the pages, and explains important conditions. The user can then ask Dasher to reconfigure the same evidence for a homeowner, outdoor enthusiast, business operator, or emergency-management leader.

### First-test success criteria

A pilot user can go from the example request to a coherent dashboard without selecting metrics or chart types. Within 30 seconds of seeing the result, the user can answer:

1. What is happening now?
2. What changed?
3. What deserves attention?
4. What should I do or inspect next?
5. Can I reach the evidence for this claim within two interactions?

## Second vertical slice: Spending and Cash Flow

Input: an Excel workbook containing Date, Description, Category, Amount, Account, and optional Budget Amount.

The generated dashboard should cover income, expenses, net cash flow, category mix, monthly trends, actual versus budget, largest transactions, recurring payments, rapidly increasing categories, anomalies or duplicates, projected month-end spending, and a plain-language summary. Conversational reconfiguration should support time windows, exclusions, essential/discretionary grouping, business-owner framing, and savings questions.

## Later vertical slices

### Team and organizational health

Combine employee lists, project trackers, time-off calendars, engagement surveys, hiring plans, and budgets into executive summary, capacity, project health, people signals, hiring needs, budget, pressure points, and recommended actions.

### Executive account meeting command center

Combine account briefs, meeting notes, emails, opportunities, support issues, and current company news into account health, what changed, opportunity and stakeholder maps, executive priorities, risks, meeting readiness, next-best actions, and an evidence drawer.

## Multi-dashboard workspace

> **Superseded (Amendment 01 A3, accepted 2026-08-31).** The pilot workspace
> holds dashboards of one kind, with the lifecycle `draft → active → archived`.
> Archiving is reversible, retains authorized access, and removes the dashboard
> from default views; explicit delete transitions any state to access-revoked
> cleanup. Workspace scale is managed by archiving and search — this baseline
> therefore gains a requirement for dashboard search across title, audience,
> source, and freshness (unbuilt). No dashboard expires automatically, and no
> dashboard is destroyed on a timer. The Scratch/Board split, TTL policy,
> promotion, and quarantine below are retained as text only, so the review
> trail stays legible.

The pilot target is a Workspace container/registry with multiple Boards and
Scratches, not a single dashboard per user or organization. A Scratch is a
disposable dashboard; a Board is a durable dashboard. Published is a later
reviewed audience projection of one immutable Board version, never a dashboard
kind, lifecycle state, `active`, or working head. Decision Snapshots and Recipes
are separately gated future product records.

- Durable dashboards preserve version history, support manual refresh and an
  explicitly authorized schedule, preserve the prior good version on failure,
  and show what changed since an identified prior version with value and
  provenance.
- Disposable dashboards require an explicit expiry, cannot schedule recurring
  work, revoke access and enter secure cleanup at expiry, and expose
  cleanup state. The default TTL is 24 hours, with 1-hour/24-hour/7-day/30-day
  user presets, a 1-hour minimum, and a hard maximum of 30 days from creation;
  an organization administrator may set the default only from 1 hour through 7
  days. Expiry is fixed at creation and inclusive at `now >= expires_at`; there
  is no renewal or arbitrary-timestamp pilot UX.
- An authorized user may explicitly promote an unexpired disposable dashboard
  to durable. Promotion preserves snapshots, evidence, accepted and candidate
  versions, calculations, and origin lineage; it does not silently add a
  schedule, source authority, publication, or audience. The promoted Board head
  remains private until separately reviewed/published; a Board cannot become a
  Scratch, and pin/bookmark/share never extends Scratch TTL.

These are approved product directions, not implemented capabilities in the
current foundation.

## Dashboard interaction contract

The 30-second default projection has fixed Known, Changed, Important, Next safe
action, and Evidence slots. Freshness, metric-contract, or comparison failure
displaces the affected insight rather than becoming a footnote. A change drawer
is the first interaction and technical evidence lineage the second; raw run
logs are not required for manager use.

Every dashboard:

- Can contain multiple pages.
- Has a clear title, freshness state, source state, and one obvious next action.
- Supports conversational reconfiguration without silently changing the underlying evidence.
- Makes generated calculations and transformations inspectable.
- Provides an `Architecture` button that opens a simple diagram understandable to a nontechnical user. The diagram explains, in plain language, the inputs, refresh path, transformations/calculations, AI contribution, pages/components, and outputs/alerts. Technical detail may be progressively disclosed but is not the default.
- Distinguishes measured facts, calculated values, AI interpretations, and recommendations.

## Agentic creation contract

The target creation experience uses one governed adaptive orchestrator that
may form dynamic plans, use bounded specialist or reviewer passes, generate
multiple creative candidate `DashboardSpec` values, and revise candidates from
structured validation feedback. Within a reviewed component and calculation
contract, it may explore narratives, layouts, components, metrics,
comparisons, and transformations. Governed does not mean template-bound.

Hard safety constraints remain fixed: models have no credentials or ambient
authority and cannot execute arbitrary code or SQL, create hidden side effects,
or present unsupported claims. Models may propose typed calculation graphs and
safe expressions; trusted deterministic services validate types, units,
evidence, authorization, resources, and policy, then execute accepted graphs.
The output remains a declarative, versioned `DashboardSpec` while the generated-
code gate is closed.

Tools are typed and capability-scoped, with current authorization checked on
every use and result commit. Runs and checkpoints have a durable append-only
ledger and claim-to-source evidence chain. Autonomy is tiered, and a human must
approve new or broadened authority, sources/connections, publication or
audience, and recurring schedules or costs. Provider access is neutral behind
the model gateway; fake-provider, replay, adversarial, and evaluation modes
precede live enablement. ADR-005 defines the proposed architecture and gates;
none of these harness capabilities is claimed as implemented.

## Identity and sign-in target

External identity providers are optional integrations, not a prerequisite for
the product. The target authentication boundary resolves every successful sign-
in to a provider-neutral verified principal and current organization authority.
A built-in passwordless path is required; email magic links are the proposed
default. Organizations may optionally enable Google Workspace or Microsoft
Entra OIDC and may require an approved IdP by policy.

Email is a delivery address and invitation/account binding, not canonical
identity. Dasher must not automatically link accounts because email addresses
match across credentials or providers. Linking requires an explicit,
reauthenticated, policy-allowed, audited action that proves control of both
bindings. The current foundation does not provide local authentication, magic
links, or external-IdP login. Immutable identity migrations remain unchanged;
any required credential-binding evolution must be planned and added through a
new forward-only migration.

## Publication and access

The invite-only pilot supports:

- Private: only explicitly authorized organization members.

Unlisted and public publication are future capabilities. They require a
separate authorization, isolation, revocation, cache, cookie, redaction, and
human-approval gate before they can be enabled. Password protection may follow
that decision. Passing the private-pilot gates does not authorize anonymous
access.

## AI credentials and model portability

> **Superseded (Amendment 01 A1, accepted 2026-08-31).** A Dasher-operated
> provider credential is the pilot default, so an invited organization reaches
> a working dashboard without procuring an inference key. Organization BYOK is
> supported and switchable at any time. Credential selection is an explicit,
> stored, per-organization choice; Dasher never falls back from one credential
> to another for any reason — a missing or failing credential produces a clear
> error and no inference call. A2 additionally requires an evaluation harness
> that runs a fixed request corpus against each candidate provider and compares
> the resulting plans deterministically — composition quality, request
> adherence, revision behaviour, refusals, latency, and cost — with the first
> live provider chosen by that evidence rather than fixed in advance.

- Organization-level BYOK is the pilot default.
- Provider credentials are encrypted and never exposed to generated code or browser clients.
- Credentials are tenant-scoped, administrator-managed, auditable, revocable,
  and usable only by the relevant gateway or broker.
- Provider or credential fallback never crosses organizations, credential
  owners, billing principals, regions, or retention policies.
- Model adapters use an OpenAI-compatible boundary where practical.
- The first release implements the architecture for local endpoints but validates only one known local deployment later; local-model support is not a launch dependency.

## Refresh

Durable dashboards first support manual refresh and one explicitly authorized
daily schedule. Refresh runs are observable, idempotent where possible, expose
changed-since value and provenance, and preserve the previous good version if a
refresh fails. Disposable dashboards cannot schedule recurring work.

## Generated code

Generated code is a possible future isolated extension, not a pilot
capability. `docs/security/GENERATED_CODE_GATE.md` remains `Status: CLOSED`.
During the pilot, models may propose only a strict declarative
`DashboardSpec`; reviewed deterministic services compute metrics, and the
reviewed renderer displays validated component kinds.

No trusted-process execution, provider-hosted web search or code interpreter,
model tool, arbitrary stdio MCP, browser-origin execution, or generated
workload access to credentials may bypass the gate. A future isolated
extension requires every sandbox, capability, resource, egress, provenance,
output, review, and human-approval invariant in the generated-code gate, plus
an explicit owner decision.

## Visual direction

Calm executive software: high information clarity, restrained color, plain language, no developer terminology in default views, and one obvious next action on every screen. Trust and freshness states must be visible without dominating the dashboard.

## Invite-only pilot boundaries

The initial release does not include public signup or self-serve billing. Administrators invite users, manage organizations, approve connectors/MCP servers, configure model credentials, and control publication policy.

## Non-goals for the first river slice

- Building all named connectors.
- General-purpose code execution without sandboxing.
- Autonomous real-world actions.
- Emergency dispatch or safety-critical flood warnings.
- Claims that the dashboard replaces official USGS or emergency-management guidance.
- Public signup or billing.

> **On the tension between threshold alerts and these non-goals:** decided
> 2026-08-26 — the disclaimer stands as the boundary and the planner may emit
> emergency-shaped titles and audiences; no composition-contract constraint is
> added. The residual risk and its reopening conditions are recorded in
> [the decision](2026-08-26-a5-alerting-decision.md); legal review remains a
> blocker for a real pilot user beyond the owner.
