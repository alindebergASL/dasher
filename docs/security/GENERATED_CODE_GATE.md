# Generated Code Enablement Gate

Status: CLOSED
Date: 2026-07-29

Dasher is intended to support creative generated code, but generated-code execution is disabled until every hard invariant below is implemented and independently verified. A declarative `DashboardSpec` is the only executable presentation path in the foundation slice.

## Hard invariants

1. Untrusted code never executes in the web process, control-plane worker, database host, or application browser origin.
2. Every run uses a disposable, non-root sandbox with a read-only root filesystem, no host/container socket, no cloud metadata access, and no ambient credentials.
3. Network access is denied by default. Approved data is passed as an immutable input bundle; any exceptional egress uses a separate broker and exact capability allowlist.
4. CPU, memory, process count, file count, output bytes, and wall-clock time are capped and enforced outside the guest process.
5. Dependencies come from a reviewed allowlist or pinned, content-addressed build image. Runtime package installation is denied by default.
6. The sandbox accepts an explicit capability manifest and returns only a narrow JSON/artifact output contract.
7. Inputs, generated source, policy result, runtime image digest, output hashes, logs, and actor/organization context are auditable.
8. Outputs pass schema, content, malware, size, and publication-policy checks before use.
9. No generated-code output can directly publish, install a connector/MCP server, retrieve a secret, change authorization, or perform a real-world action.
10. A human must approve a code-backed component before it leaves a private draft.

## Required adversarial tests

- Attempts to read environment variables, host files, process information, and neighboring tenant data.
- Path traversal, symlink/hard-link escapes, device files, and oversized/sparse outputs.
- Fork/process bombs, infinite loops, memory exhaustion, and compressed/decompression bombs.
- Direct and DNS-rebinding access to loopback, RFC1918, link-local, IPv6 local, and cloud metadata endpoints.
- Secret exfiltration through DNS, HTTP, error messages, logs, artifact names, and rendered content.
- Browser escape attempts through scripts, event handlers, same-origin access, navigation, popups, downloads, and cross-window messaging.
- Dependency confusion and malicious package lifecycle scripts.
- Cancellation/timeout races, sandbox reuse, stale mounts, and cleanup failures.
- Publish-after-policy-change and tenant-switch TOCTOU cases.

## Enablement decision

The gate can move from CLOSED to PILOT only when:

- hard-invariant tests pass on the exact sandbox image and broker code;
- an independent security review reports no blockers;
- the runtime is isolated from the main EC2 application host or uses a comparably strong managed sandbox boundary;
- monitoring, kill switch, cost limits, and incident-response procedures exist;
- the owner explicitly approves a bounded private pilot.

Until then, generated code may be produced as a reviewable artifact but is not run.
