# Ouro

Ouro is the local-first outbound execution engine for reproducible AI-agent loops. It turns one
external Work item into a pinned, inspectable execution path:

```text
Work -> Plan -> Task -> ContextBundle -> ProcedureBinding -> Run -> Attempt -> Gate -> Result
```

Ouro owns execution state. [Bouro](https://github.com/semigrp/bouro) owns knowledge meaning,
Evidence, and Decisions. [Fukuro](https://github.com/semigrp/fukuro) owns telemetry analysis,
baselines, and Findings. Repositories own executable artifact bytes, while issue trackers own issue
and pull-request state.

## System boundary

| Concern | Source of truth |
| --- | --- |
| Source, prompts, workflows, procedure bytes | Repository or artifact store |
| Issue and pull-request state | External issue tracker |
| Work projection, Plan, Task, Run, Attempt, Gate, workspace binding | Ouro |
| Concept, Claim, Question, Hypothesis, ExperimentDefinition | Bouro |
| ProcedureDefinition, Evidence meaning and Decision | Bouro |
| Telemetry ingestion, baseline, Finding, improvement effect | Fukuro |

Ouro never writes another system's database or vault. The Bouro integration uses explicit CLI
query/command calls. The Fukuro integration is deterministic NDJSON export from Ouro's event log.
There is no shared package, integration repository, event broker, or distributed transaction.

See [ADR 0001](docs/adr/0001-ouro-boundary-and-execution.md).

## Guarantees

- Every Run pins the Bouro Experiment, ProcedureDefinition, ContextBundle, ontology release, and
  selected knowledge revisions used for execution.
- A ProcedureArtifact requires a logical version, URI, and SHA-256 digest.
- Verified procedure bytes are copied to a Run-owned snapshot before execution; the snapshot is
  what the process actually runs.
- Processes are spawned without a shell and receive only explicitly inherited or set environment
  variables plus Ouro's input locator.
- Timeout, bounded output capture, retry, and exit-code Gates are persisted per Attempt.
- Store replacement is atomic and one writer lock serializes a Run.
- Execution events form an append-only SHA-256 chain.
- The event log is also the Fukuro outbox. Re-export preserves each Ouro event ID as
  `sourceEventId`.
- Evidence registration uses a durable Bouro outbox. A completed Run stays complete when delivery
  fails, and replay uses the same Bouro idempotency key.
- Telemetry is field-whitelisted and strips all ResourceRef URIs. It never includes environment
  values, input values, stdout, stderr, prompts, or credentials.
- `doctor` verifies store structure, event-chain integrity, ContextBundle digest, reference
  consistency, and local Run artifact bytes.

## Quick start

Requirements: Node.js 20 or newer and pnpm.

```bash
git clone git@github.com:semigrp/ouro.git
cd ouro
pnpm install
pnpm test
pnpm run demo
pnpm run doctor
```

The default store is `.ouro/store.json`; generated Run artifacts live under `.ouro/artifacts`.
Override the store with `--store <path>`.

## Run a Work item

Create an `ouro.run-request/v1` document using
[`contracts/fixtures/run-request.valid.json`](contracts/fixtures/run-request.valid.json) as the
shape reference. Replace all example ResourceRefs, paths, versions, and digests with real pinned
values.

Configure the Bouro receiver and execute:

```bash
export BOURO_BIN=/absolute/path/to/bouro/dist/bin/bouro.js
export BOURO_VAULT=/absolute/path/to/bouro/vault/store.json

node dist/bin/ouro.js run --spec ./run-request.json
node dist/bin/ouro.js show --run RUN-0001
```

`inspect` is the only permission tier accepted by default. Higher declared tiers require an
explicit invocation gate:

```bash
node dist/bin/ouro.js run \
  --spec ./run-request.json \
  --allow-tier workspace-write
```

Permission tiers are authorization declarations, not an operating-system sandbox. A procedure
still has the permissions of the user running Ouro. Use a container, VM, restricted OS account, or
another external sandbox for untrusted artifacts. Ouro does not support shell pipelines.

## Downstream replay

Export deterministic Fukuro telemetry:

```bash
node dist/bin/ouro.js events export --target fukuro > ouro-events.ndjson
node dist/bin/ouro.js events export --target fukuro --since EVT-000010
```

Retry pending Bouro Evidence commands:

```bash
node dist/bin/ouro.js bouro flush
```

Fukuro 0.6.0 does not yet publish `fukuro.telemetry-event/v1` ingest. Ouro vendors the confirmed
receiver-contract snapshot and produces validated NDJSON without blocking Runs. Once Fukuro owns
the schema, the snapshot must track the receiver contract and the exported stream can be piped to
its ingest command.

## CLI

```text
ouro init
ouro doctor
ouro status
ouro run --spec <run-request.json>
ouro show --run <RUN-id>
ouro events export --target fukuro [--since <EVT-id>] [--run <RUN-id>]
ouro bouro flush
ouro demo
```

## Contracts

- `contracts/run-request.v1.schema.json` is owned by Ouro.
- `contracts/resource-ref.v1.schema.json` embeds the common identity convention.
- `contracts/bouro-context-query.v1.schema.json` is a producer-side Bouro snapshot.
- `contracts/bouro-register-evidence.v1.schema.json` is a producer-side Bouro snapshot.
- `contracts/fukuro-telemetry-event.v1.schema.json` is the pending Fukuro receiver snapshot.

CI checks the Bouro snapshots against a separate checkout of the actual Bouro repository and runs
a real cross-repository Context query, Ouro process, Evidence registration, and idempotent replay.

## Current scope

The first release deliberately supports one Work, one generated Plan and Task, and one pinned
ProcedureArtifact per Run. It does not yet provide concurrent writers, a scheduler, multi-agent
routing, remote secret injection, process-tree isolation, or automatic knowledge promotion.

The acceptance evidence and external Fukuro dependency are tracked in
[ACCEPTANCE.md](docs/ACCEPTANCE.md).

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE).
