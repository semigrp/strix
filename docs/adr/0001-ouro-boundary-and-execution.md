# ADR 0001: Ouro boundary and execution architecture

- Status: Accepted
- Date: 2026-07-14

## Context

The agent loop is split into three bounded contexts. Bouro owns durable knowledge meaning,
Evidence, and Decisions. Fukuro owns telemetry analysis, baselines, and Findings. Repositories and
artifact stores own executable bytes, while issue trackers own issue and pull-request state. Ouro
needs to own the outbound execution path without becoming any of those systems.

## Decision

Ouro is an independent TypeScript/pnpm repository and the source of truth for Work projections,
Plans, Tasks, Runs, Attempts, run-specific Gates, workspace bindings, retries, and timeouts. There
is no integration repository, shared npm package, event broker, or distributed transaction.

### Execution path

The initial supported path is deliberately narrow:

```text
Work -> Plan -> Task -> ContextBundle -> ProcedureBinding -> Run -> Attempt -> Gate -> Result
```

One Run executes one version- and digest-pinned ProcedureArtifact. The artifact is resolved within
the declared workspace, its SHA-256 digest is checked before any Run record is created, and the
process is launched without a shell. Permission tiers are explicit policy gates; they are not a
claim of operating-system sandboxing.

### Bouro boundary

Ouro queries Bouro for a pinned ContextBundle before execution. Ouro stores the bundle reference,
digest, ontology reference, query, and selected revisions as reproducibility inputs, not as a
knowledge source of truth. Evidence registration is a Bouro-owned command. Ouro records that
command in a durable outbox keyed by the terminal execution event and may retry delivery. Bouro
provides receiver-side idempotency.

ExperimentDefinition and ProcedureDefinition remain Bouro objects. Ouro stores only their pinned
ResourceRefs plus the run-specific ProcedureBinding.

### Fukuro boundary

Ouro's append-only execution event log is also its telemetry outbox. Export maps each internal
event to one `fukuro.telemetry-event/v1` record and preserves the Ouro event ID as
`sourceEventId`. Re-exporting the same log is deterministic. Exported data is field-whitelisted and
does not include prompts, environment values, credentials, stdout, or stderr. Fukuro availability
never blocks execution.

The current Fukuro 0.6.0 repository does not yet expose this receiver contract or NDJSON ingest.
Ouro therefore vendors the confirmed contract snapshot for producer-side validation; ownership
remains with Fukuro and the snapshot must be replaced when Fukuro publishes its contract.

### Identity and persistence

Cross-system references use only the embedded `ResourceRefV1` convention. Persistent experiment,
procedure, context, artifact, workspace, output, and Evidence references pin `version` or `digest`.
Ouro uses opaque local IDs and never parses another system's IDs.

The local JSON store is replaced atomically. Execution events form a SHA-256 chain, making removed,
reordered, or modified events detectable by `doctor`. A single Ouro process holds the writer lock
during a Run; concurrent scheduling is intentionally deferred.

## Consequences

Ouro can replay telemetry and Evidence delivery after downstream outages, and every completed Run
can identify its Work projection, Plan, Task, Bouro context and definitions, artifact commit and
digest, workspace, input artifact, attempts, gates, and output artifacts. Raw output remains in the
local run artifact directory and never enters telemetry.

The first release does not implement multi-agent routing, a scheduler, shell pipelines, automatic
knowledge promotion, remote secret injection, or concurrent writers. Those features require
measured demand and explicit safety models.
