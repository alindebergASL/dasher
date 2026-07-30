# ADR-002: USGS Live Adapter Boundary

Status: Accepted
Date: 2026-07-29

## Decision

The live river connector will call only documented USGS Water Services and monitoring-location hosts through a source broker. It will normalize responses into the same `RiverGauge` contract used by deterministic fixtures. The dashboard planner and renderer never consume raw remote responses.

## Required controls

- HTTPS only.
- Exact host allowlist for documented USGS services; no user-supplied arbitrary URL.
- DNS resolution and destination checks that reject loopback, private, link-local, multicast, and cloud-metadata addresses.
- Redirect limit of zero unless a specific documented redirect is approved and revalidated.
- Connect, read, total, response-size, and station-count limits.
- Strict content-type and schema validation.
- Parameter allowlist for gauge height (`00065`) and discharge (`00060`) in the first slice.
- Source URL, station ID, units, retrieved time, observation time, response hash, and adapter version recorded with each normalized snapshot.
- Bounded retries with jitter for transient failures; no retry for policy or schema failures.
- Cache keyed by normalized request plus adapter version.
- Failed refresh preserves the prior good dashboard version and displays the failure/freshness state.

## Fixture refresh

Fixtures are updated only by an explicit maintainer command. The command writes to a temporary file, validates and normalizes it, removes unrelated stations/fields, and requires review of the resulting diff. CI never calls USGS.

## Validation gate

Before enabling live calls, add tests for allowed requests, blocked private/metadata destinations, redirect rejection, oversized responses, timeouts, malformed JSON, no-data sentinels, unit drift, duplicate station series, and partial station failure. Run one approved live no-write probe and compare its normalized output to the contract.

## Acceptance record

Accepted as the required boundary for the controlled live-source and job proof
in the private-pilot roadmap. Acceptance approves this target design; it does
not mean the adapter, source broker, raw-ingress controls, durable snapshots,
jobs, or live calls are implemented or enabled. Gate 3 remains blocked until
ADR-003's tenant/control-plane prerequisites and this ADR's validation gate pass
on the exact implementation and environment.
