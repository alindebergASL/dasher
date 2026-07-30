# Dasher Product Requirements

Status: Approved baseline
Date: 2026-07-29
Domain: `luckbutton.com`
Repository: `alindebergASL/dasher`

## Product thesis

Dasher turns a plain-language monitoring or decision request plus ordinary data sources into a useful, evidence-backed, multi-page dashboard. The user should not have to define KPIs, choose chart types, or organize the source material. Dasher determines what matters, builds the dashboard, explains its conclusions, and lets the user reconfigure it conversationally.

## Initial customer

Invite-only pilot for managers and leaders, including CEOs and executive teams. The product is simple by default, with power-user and administrator controls progressively revealed. The data and authorization model must be multi-tenant-ready from the first durable implementation.

## Initial source priority

1. Web research, with visible citations and claim-level evidence reachable in no more than two clicks.
2. CSV/XLSX upload.
3. Google Sheets.
4. Administrator-installed and administrator-approved MCP sources. Normal users see only safe, named connections.

Later connector targets include Salesforce, HubSpot, Stripe, QuickBooks, Google Analytics, Snowflake, PostgreSQL, Airtable, Notion, and appropriate travel-data services. These are roadmap targets, not MVP scope.

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
5. Where did this claim come from?

## Second vertical slice: Spending and Cash Flow

Input: an Excel workbook containing Date, Description, Category, Amount, Account, and optional Budget Amount.

The generated dashboard should cover income, expenses, net cash flow, category mix, monthly trends, actual versus budget, largest transactions, recurring payments, rapidly increasing categories, anomalies or duplicates, projected month-end spending, and a plain-language summary. Conversational reconfiguration should support time windows, exclusions, essential/discretionary grouping, business-owner framing, and savings questions.

## Later vertical slices

### Team and organizational health

Combine employee lists, project trackers, time-off calendars, engagement surveys, hiring plans, and budgets into executive summary, capacity, project health, people signals, hiring needs, budget, pressure points, and recommended actions.

### Executive account meeting command center

Combine account briefs, meeting notes, emails, opportunities, support issues, and current company news into account health, what changed, opportunity and stakeholder maps, executive priorities, risks, meeting readiness, next-best actions, and an evidence drawer.

## Dashboard interaction contract

Every dashboard:

- Can contain multiple pages.
- Has a clear title, freshness state, source state, and one obvious next action.
- Supports conversational reconfiguration without silently changing the underlying evidence.
- Makes generated calculations and transformations inspectable.
- Provides an `Architecture` button that opens a simple diagram understandable to a nontechnical user. The diagram explains, in plain language, the inputs, refresh path, transformations/calculations, AI contribution, pages/components, and outputs/alerts. Technical detail may be progressively disclosed but is not the default.
- Distinguishes measured facts, calculated values, AI interpretations, and recommendations.

## Publication and access

Initial release supports:

- Private: only explicitly authorized organization members.
- Unlisted: revocable, high-entropy links; not indexed; optional expiry; no sensitive data by default.
- Public: deliberately published and indexable only after an explicit review step.

Password protection may follow. Public and unlisted publication are disabled for dashboards containing source classes or fields marked sensitive unless an administrator-approved redaction policy passes.

## AI credentials and model portability

- Organization-level BYOK is the pilot default.
- A server-administrator-managed fallback may be configured.
- Provider credentials are encrypted and never exposed to generated code or browser clients.
- Model adapters use an OpenAI-compatible boundary where practical.
- The first release implements the architecture for local endpoints but validates only one known local deployment later; local-model support is not a launch dependency.

## Refresh

The first release supports manual refresh and one daily schedule per dashboard. Refresh runs are observable, idempotent where possible, and preserve the previous good version if a refresh fails.

## Generated code

Dasher permits generated code for flexibility and creative visualizations, but never executes arbitrary code inside the web process, worker control plane, database host, or browser origin with application credentials.

Generated code must run in a capability-bounded sandbox with:

- No secrets by default.
- No ambient filesystem or tenant-database access.
- Deny-by-default network policy and explicit source allowlists.
- CPU, memory, output-size, and wall-clock limits.
- Immutable input bundles and explicit output contracts.
- Dependency allowlists or reviewed, pinned build images.
- Static and runtime policy checks.
- Full provenance: prompt/request, code hash, runtime image, inputs, outputs, and logs.
- Human approval before publishing code-backed components outside a private draft.
- A safe declarative dashboard specification as the normal path; code is an isolated extension mechanism, not the control plane.

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
