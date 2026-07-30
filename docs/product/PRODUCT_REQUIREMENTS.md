# Dasher Product Requirements

Status: Approved baseline
Date: 2026-07-29
Updated: 2026-07-30
Domain: `luckbutton.com`
Repository: `alindebergASL/dasher`

## Product thesis

Dasher turns a plain-language monitoring or decision request plus ordinary data sources into a useful, evidence-backed, multi-page dashboard. The user should not have to define KPIs, choose chart types, or organize the source material. Dasher determines what matters, builds the dashboard, explains its conclusions, and lets the user reconfigure it conversationally.

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

## Dashboard interaction contract

Every dashboard:

- Can contain multiple pages.
- Has a clear title, freshness state, source state, and one obvious next action.
- Supports conversational reconfiguration without silently changing the underlying evidence.
- Makes generated calculations and transformations inspectable.
- Provides an `Architecture` button that opens a simple diagram understandable to a nontechnical user. The diagram explains, in plain language, the inputs, refresh path, transformations/calculations, AI contribution, pages/components, and outputs/alerts. Technical detail may be progressively disclosed but is not the default.
- Distinguishes measured facts, calculated values, AI interpretations, and recommendations.

## Publication and access

The invite-only pilot supports:

- Private: only explicitly authorized organization members.

Unlisted and public publication are future capabilities. They require a
separate authorization, isolation, revocation, cache, cookie, redaction, and
human-approval gate before they can be enabled. Password protection may follow
that decision. Passing the private-pilot gates does not authorize anonymous
access.

## AI credentials and model portability

- Organization-level BYOK is the pilot default.
- Provider credentials are encrypted and never exposed to generated code or browser clients.
- Credentials are tenant-scoped, administrator-managed, auditable, revocable,
  and usable only by the relevant gateway or broker.
- Provider or credential fallback never crosses organizations, credential
  owners, billing principals, regions, or retention policies.
- Model adapters use an OpenAI-compatible boundary where practical.
- The first release implements the architecture for local endpoints but validates only one known local deployment later; local-model support is not a launch dependency.

## Refresh

The first release supports manual refresh and one daily schedule per dashboard. Refresh runs are observable, idempotent where possible, and preserve the previous good version if a refresh fails.

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
