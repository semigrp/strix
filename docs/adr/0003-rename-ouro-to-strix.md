# ADR 0003: Rename ouro to Strix with read compatibility

- Status: Accepted
- Date: 2026-07-23

## Context

The repository moved from `semigrp/ouro` to `semigrp/strix`. Strix names the owl
at the pre-push checkpoint and aligns this component with Fukuro without reviving
the execution engine removed by ADR 0002.

Changing only the repository name leaves the package, CLI, configuration, marker,
hook environment, and Fukuro telemetry identity inconsistent. Changing every
identifier without compatibility would invalidate green markers, break hooks, and
allow old gate records to be re-imported under a second producer identity.

## Decision

Use `strix` as the canonical package, CLI, file, configuration, marker, environment
variable, documentation name, and telemetry producer.

Keep bounded read compatibility:

- publish `ouro` as a CLI alias for the same `cli/strix.ts` entry point;
- read `.ouro.json` only when `.strix.json` is absent;
- accept `OURO_GUARD_LOG` only when `STRIX_GUARD_LOG` is unset;
- accept an exact-HEAD `ouro-gate-pass` marker, while writing only
  `strix-gate-pass`;
- read `ouro-last-gate.json` only when no Strix record exists and emit it with its
  original `ouro` producer and event kinds.

New gate records carry `producer: strix` and emit `strix_gate_passed` or
`strix_gate_failed`. Historical Ouro records keep their old wire identity so a
post-upgrade re-emit does not duplicate Fukuro history.

ADRs 0001 and 0002 remain unchanged as historical records.

## Consequences

- New installations and documentation consistently use Strix.
- Existing hooks, configs, markers, and un-emitted records continue to work.
- Compatibility paths are one-way: Strix writes no new Ouro-named state.
- Removing the aliases requires a later ADR with observed usage evidence.
