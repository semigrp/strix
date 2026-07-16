# Ouro acceptance evidence

This document maps the accepted Ouro scope to executable evidence. It does not claim that the
separate Fukuro receiver work is complete.

| Requirement | Evidence | Status |
| --- | --- | --- |
| One Work executes one ProcedureArtifact | CLI demo and golden-path engine test | Pass |
| Work, Plan, Task, Run, Attempt, Gate are Ouro-owned | Store model and `show --run` projection | Pass |
| ExperimentDefinition and ProcedureDefinition remain Bouro refs | RunRequest contract and ADR 0001 | Pass |
| ContextBundle and selected resources are version/digest pinned | Context integrity checks and cross-repo test | Pass |
| Procedure commit, digest, verified bytes, inputs, outputs are traceable | Run record plus artifact audit | Pass |
| Artifact mismatch is rejected before Context query and Run creation | Artifact mismatch test | Pass |
| Retry and timeout are Attempt-level execution state | Retry and timeout tests | Pass |
| Gate result is Run-specific, not a Bouro Decision | Gate model and ADR 0001 | Pass |
| Same execution event always exports the same `sourceEventId` | Deterministic NDJSON test | Pass |
| Fukuro outage does not block or roll back a Run | Downstream outage test | Pass |
| Evidence command survives delivery failure and replays idempotently | Outbox test and real Bouro replay test | Pass |
| No cross-database writes or distributed transaction | CLI adapters and ADR 0001 | Pass |
| Telemetry excludes input/output bodies, environment values, local URIs, and secret-like fields | Contract, whitelist, and redaction tests | Pass |
| Corrupt event history and artifact bytes are detected | Event-chain and artifact-audit tests | Pass |
| Cross-repository golden path runs in CI | `BOURO_ROOT` test with separate Bouro checkout | Pass |

## External dependency

Fukuro 0.6.0 currently has no `fukuro.telemetry-event/v1` receiver contract, NDJSON ingest command,
`source_event_id`, or `ingested_at` migration. Ouro therefore proves deterministic producer output
and downstream independence, but cannot prove Fukuro's duplicate-ingest count or occurred/ingested
time separation. Those are Fukuro-owned acceptance items and must be implemented in that repo.

## Deferred by design

- Multiple concurrent writer processes and scheduling
- Resume of an interrupted in-progress process after host failure
- Operating-system sandbox enforcement and process-tree containment
- Secret-manager integration
- Gate types beyond exit-code comparison
- Automatic Finding-to-Evidence promotion
