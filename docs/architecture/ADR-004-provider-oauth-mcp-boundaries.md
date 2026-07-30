# ADR-004: Provider, OAuth, and MCP Boundaries

Status: Accepted
Date: 2026-07-30
Depends on: ADR-003

## Decision

Dasher will use a provider-neutral model gateway for inference and a separate,
capability-scoped broker for external tools. Standard organization-owned API
keys are the supported general provider path. Subscription, OAuth, access
token, and MCP paths are enabled only when their documented usage contract and
the gates below allow them.

This ADR accepts boundaries and dispositions; it does not claim a gateway,
credential store, OAuth integration, or MCP broker exists in the current
fixture foundation.

## Credential disposition

| Credential or integration class                            | Disposition                   | Dasher posture                                                                                                                                                                            |
| ---------------------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Standard QwenCloud/Model Studio pay-as-you-go API key BYOK | **PASS**                      | First live model path, restricted to an exact approved endpoint, region/workspace, credential class, and model allowlist.                                                                 |
| Standard OpenAI Platform API key BYOK                      | **PASS**                      | Supported general API path, tenant-owned and restricted to the tenant's project and the gateway policy.                                                                                   |
| Consumer Codex/ChatGPT OAuth or subscription token         | **HOLD**                      | Unsupported for Dasher SaaS today. Do not collect tokens, import local auth files, scrape cookies, copy another client's public identifier, or call undocumented endpoints.               |
| Codex Business/Enterprise access token                     | **CAUTION / HOLD**            | No implementation until a documented or provider-confirmed Dasher app-server contract satisfies the workspace, identity, provisioning, rotation, revocation, and tool-denial gates below. |
| Qwen Coding Plan or Token Plan credential for backend use  | **REJECT**                    | These plans are not Dasher backend credentials. Reject unsupported credential/endpoint combinations before prompt data leaves.                                                            |
| Generic MCP server                                         | **CAUTION / deferred**        | No arbitrary discovery or stdio. A future path is remote HTTPS, named, admin-approved, pinned, read-only, and brokered.                                                                   |
| Official Google Workspace MCP                              | **CAUTION / read-only gated** | Native read-only Google Sheets comes first. A later remote MCP facade may expose only an exact approved read-only manifest.                                                               |

Credential class must be established from configured product, issuer,
endpoint, workspace/region, provider validation, and explicit administrator
selection. A key prefix alone is never sufficient.

## Provider-neutral gateway contract

The gateway receives a typed request containing organization, actor, current
authority revision, credential connection identifier, provider and model
policy, stage, request ID, approved input snapshot/evidence identifiers, and
token, latency, and cost ceilings. It returns typed content, provider/model
metadata, metering, and sanitized failure information.

The gateway must:

1. Reauthorize the actor, organization, connection, credential version,
   provider policy, and budget immediately before every transport attempt.
2. Validate the exact endpoint, region/workspace, credential class, and model
   before sending prompt data. Tenant-supplied arbitrary compatible base URLs
   are not allowed.
3. Disable provider-hosted web search, code interpreters, file tools, remote
   MCP, and other tools. Provider requests are inference-only.
4. Apply conservative spend and concurrency limits before transport. A
   blocked budget produces no provider call.
5. Disable opaque SDK retries unless every attempt repeats authorization and
   budget checks.
6. Reauthorize before storing results, usage, caches, audit records, or a
   dashboard candidate. Revoked or stale work is discarded.
7. Never fall back across tenants, credential owners, account products,
   billing principals, regions, retention classes, or from user OAuth to an
   administrator key.

Qwen standard BYOK is the first planned live provider proof. OpenAI Platform
BYOK uses the same contract and is not a fallback credential owned by Dasher.

## Credential lifecycle

Credentials are tenant-scoped and administrator-managed. They are encrypted
with envelope keys outside the application database; only the relevant
gateway or broker decrypts them in memory for one operation. Browser clients,
web/API processes, general workers, models, job payloads, logs, errors, and
artifacts never receive secret material.

Creation validates the provider product and exact endpoint/region/workspace
combination before any customer data is sent. Rotation creates a new
credential version and preserves non-secret audit history. Refresh-token
rotation, if a future supported OAuth path needs it, is serialized per
credential to prevent concurrent replacement races. Revocation immediately
quarantines the credential, cancels pending derived work, rejects new calls,
and prevents in-flight results from committing. Disconnect/logout revokes
upstream where supported and deletes locally held secret material according
to retention policy.

Audits identify the credential connection and version, actor, organization,
provider, model, endpoint class, outcome, and usage without recording the
credential, authorization headers, raw provider errors, or unnecessary prompt
content.

## Model-output boundary

Models may classify source fields, propose mappings and plans, explain
deterministic results, and propose a strict versioned `DashboardSpec`. Models
do not compute authoritative metrics, fetch new sources during repair, select
credentials, change endpoint policy, install or call tools, publish, or
execute code.

Output is untrusted. Unknown fields and component kinds, non-finite values,
unsafe URLs, invented or cross-tenant evidence identifiers, unsupported
calculations, tool requests, and policy changes fail validation. A repair
attempt receives only the same approved input set; research or tool use is a
new separately authorized source job. Generated-code execution remains
`CLOSED`.

## Codex paths

Consumer ChatGPT/Codex authentication is `HOLD`. Local subscription sign-in is
documented for Codex clients, not as a generic OAuth grant for a third-party
multi-tenant SaaS. Dasher will not accept consumer tokens, local authentication
file uploads, cookies, scraped sessions, copied client identifiers, or
undocumented token exchange.

Codex Business/Enterprise access tokens remain `CAUTION / HOLD`. They may be
reconsidered only after a documented or provider-confirmed contract says
Dasher is an allowed app-server workflow and all of the following are proven:

- a tenant workspace administrator provisions and owns the connection;
- the creating user and exact ChatGPT workspace are bound and verified on
  every workflow;
- each workflow has an explicit user/service identity and no cross-tenant or
  cross-workspace reuse;
- storage, serialization of rotation, expiry, quarantine, revocation, and
  removal behavior are tested;
- the adapter is inference-only, with repository, shell, filesystem, browser,
  MCP, provider-hosted tools, and execution denied; and
- provider and legal review confirm the contract before implementation.

OpenAI Platform BYOK remains the supported general OpenAI API path regardless
of these future paths.

## MCP authorization and transport

A future MCP connection must be a named remote HTTPS server from an
administrator-approved catalog. The approved revision pins the server URL,
publisher, authorization method, egress, tool names, descriptions, input/output
schemas, hashes, and resource scopes. Discovery happens in quarantine.
Manifest drift disables the connection pending review. Arbitrary stdio,
dynamic package execution, auto-installation, global tool discovery, and
tenant-supplied servers are outside the pilot.

For protected MCP resources, the broker must follow protected-resource
metadata and authorization-server discovery, use PKCE for every authorization
code flow, bind the request and token to the exact resource, and validate
issuer and intended audience on every use. Upstream API credentials are
separate from MCP authorization. Token passthrough is forbidden: Dasher does
not accept a token issued for another service and does not forward a Dasher,
provider, or upstream API token as MCP authorization.

Each call rechecks tenant, actor, membership, connection, manifest revision,
tool, resource, scope, and credential state. Credentials are injected inside
the broker against a narrow capability; the model never holds them.
Server-initiated model calls or sampling are disabled. Only read-only source
snapshots may be returned. Side-effect tools require a separate future ADR and
human-approval gate.

## Google first-party posture

Dasher will implement a native read-only Google Sheets connector before
exposing Google Workspace MCP. Google identity login and Google data access
use separate consent and authorization boundaries. Data connections use
least-privilege read-only scopes, per-user OAuth by default, current granted
scope validation, encrypted and revocable tokens, and no domain-wide
delegation.

The native connector snapshots only administrator/user-approved spreadsheets
and ranges with file identity, revision metadata, retrieval time, and content
hash. The model never receives an unrestricted Google token or authority to
search arbitrary Drive content.

If the official remote MCP path is later enabled, it remains behind the same
broker and exposes an exact pinned read-only facade for approved spreadsheet
listing, metadata, and range snapshot operations. Google login consent and
data-access consent remain separate. Gmail, Calendar, Chat, Drive sharing,
action tools, domain-wide delegation, sampling, and server-initiated model
calls are not transitively enabled. Every manifest change disables the
connection until reapproved.

## Prompt-injection controls

Tool descriptions, resource metadata, spreadsheets, remote responses, and
returned content are hostile data, not instructions. Dasher keeps system and
policy instructions outside source content; labels source boundaries; passes
only the minimum approved snapshot; and prevents content from selecting tools,
credentials, destinations, scopes, or actions.

The broker validates structured results, strips unsupported active content,
applies raw response byte limits before object construction or parsing, then
applies object-level snapshot and schema ceilings as defense in depth.
Evidence preserves the source and transformation. Suspicious instructions are
recorded as source content and cannot override policy. No output can authorize
a second call.

## Acceptance gates

### Standard API BYOK

- A fake-provider mode proves zero network and zero credential access while
  exercising the full planning and validation path.
- Credential class, endpoint, region/workspace, and model mismatches fail
  before prompt data leaves. Tests prove prefixes alone do not classify keys.
- Arbitrary base URLs, provider tools, unsupported credential/endpoint pairs,
  and cross-tenant fallback fail closed.
- Raw provider response bytes are capped before parsing; structured output,
  evidence, calculation, object-size, and complexity negative tests pass.
- Budget exhaustion blocks transport; retries and revocation at wait,
  pre-call, in-flight response, and commit are tested.
- Secret scans find no credential material in logs, errors, audit, jobs,
  prompts, caches, or artifacts.
- An explicitly approved, capped live smoke test and per-tenant kill switch
  pass before a provider is enabled.

### Future OAuth and MCP

- OAuth state, PKCE, callback replay, exact redirect, issuer, protected
  resource, audience, reduced-scope, rotation, expiry, and revocation tests
  pass against the authoritative provider environment.
- Malicious-server, tool-description and content prompt injection, credential
  exfiltration, SSRF/metadata, manifest drift, cross-tenant resource access,
  read-to-write escalation, sampling, and token-passthrough tests pass.
- Google tests cover separate login/data consent, removed membership,
  connection-owner disablement, admin policy change, cross-organization token
  sharing, approved-file/range enforcement, and denial of action tools.
- An unavailable authoritative contract, metadata endpoint, provider
  environment, or security control fails the gate; mocks do not enable a live
  credential path.

## Alternatives considered

### Support consumer Codex OAuth because local clients use it

Rejected. Local client mechanics do not establish a supported third-party SaaS
contract. API keys are the documented automation/general API path.

### Infer provider product from key prefix

Rejected. Credential classes and endpoints can overlap or change. Dasher
requires explicit product configuration and provider validation.

### Accept any compatible endpoint

Rejected. Portability belongs at the adapter interface. Arbitrary destinations
create SSRF and credential-exfiltration paths.

### Use MCP as the first connector layer

Rejected. Native CSV/XLSX and read-only Sheets prove the source contract with
less OAuth, manifest, tool, and prompt-injection authority.

### Use one Google consent for login and all Workspace data

Rejected. Separate identity and data authorization make scope, ownership, and
revocation legible.

## Consequences

- The pilot has a supported standard-key route without depending on consumer
  subscription authentication.
- Provider portability requires adapter and policy work, not arbitrary
  endpoints or credential guessing.
- Google and MCP arrive later, with smaller read-only authority and explicit
  drift behavior.
- Side-effect tools, generic MCP, Codex subscription auth, and generated code
  cannot become shortcuts around the accepted control-plane gates.

## Source register

All external sources below were accessed and verified on 2026-07-30.
“Documented fact” summarizes the provider/specification statement. “Dasher
decision or inference” is this ADR's policy and is not attributed to the
source.

| Source                                                                                                                | Documented fact                                                                                                                                                                                                                                                           | Dasher decision or inference                                                                                                             |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| [OpenAI Codex authentication](https://developers.openai.com/codex/auth)                                               | ChatGPT desktop, Codex CLI, and IDE support ChatGPT subscription sign-in or local API-key sign-in; API keys are recommended for programmatic workflows and general API use. The documentation warns against exposing Codex execution in untrusted or public environments. | Consumer Codex execution and subscription authentication are not a Dasher SaaS credential path.                                          |
| [OpenAI Codex access tokens](https://developers.openai.com/codex/enterprise/access-tokens)                            | Access tokens are currently for ChatGPT Business/Enterprise, tied to the creating user and workspace, and intended for trusted local CLI or app-server automation. Platform API keys remain the general API credential.                                                   | A Dasher adapter remains `CAUTION / HOLD` until its app-server contract and workspace binding are confirmed.                             |
| [OpenAI Codex CI/CD authentication](https://developers.openai.com/codex/auth/ci-cd-auth)                              | API keys are the automation method; managed authentication guidance does not apply to generic OAuth clients outside Codex.                                                                                                                                                | Token collection, local auth-file import, cookie scraping, and copied public-client flows are unsupported and prohibited in Dasher.      |
| [Alibaba Model Studio API keys](https://www.alibabacloud.com/help/en/model-studio/get-api-key)                        | Standard pay-as-you-go API keys are workspace/region scoped; available model and IP controls can vary by region.                                                                                                                                                          | Standard QwenCloud BYOK is `PASS` only behind an exact endpoint, region/workspace, and model allowlist.                                  |
| [Alibaba Model Studio Coding Plan](https://www.alibabacloud.com/help/en/model-studio/coding-plan)                     | Coding Plan prohibits automated scripts, application backends, and non-interactive scenarios.                                                                                                                                                                             | Coding Plan and Token Plan credentials are rejected for backend use; endpoint and credential class, not prefix alone, determine support. |
| [MCP authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)       | Protected-resource metadata, OAuth discovery, resource binding, and intended-audience validation are required; upstream API tokens are separate and passthrough is forbidden.                                                                                             | The broker enforces exact resource/audience binding and never treats another service's token as MCP authorization.                       |
| [MCP security best practices](https://modelcontextprotocol.io/specification/2025-11-25/basic/security_best_practices) | The specification addresses confused-deputy attacks, exact redirects and consent, token passthrough, SSRF, session hijacking, local-server compromise, and least privilege.                                                                                               | Remote HTTPS, pinned manifests, read-only tools, no sampling, and adversarial tests are prerequisites.                                   |
| [Google Workspace remote MCP](https://developers.google.com/workspace/guides/configure-mcp-servers)                   | Google's remote MCP exposes read and action tools and warns about indirect prompt injection; users should review actions.                                                                                                                                                 | Native read-only Sheets precedes a pinned read-only MCP facade; action tools require a separate future human-approval gate.              |
