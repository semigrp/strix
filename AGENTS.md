# AGENTS.md

Operating notes for AI agents (and humans) working with Ouro. Everything here is derivable from
this repository — no private context is required to reach the operational level described.

## What Ouro is, in one paragraph

Ouro is the local-first outbound execution engine of a three-tool loop: it turns one external Work
item into a pinned, inspectable path `Work → Plan → Task → ContextBundle → ProcedureBinding →
Run → Attempt → Gate → Result`. [Bouro](https://github.com/semigrp/bouro) owns knowledge meaning
and Evidence; [Fukuro](https://github.com/semigrp/fukuro) owns telemetry and baselines. Ouro never
writes another system's store — integrations are explicit CLI calls and deterministic NDJSON
export. See README's system-boundary table.

## Setup to operational level

```bash
git clone https://github.com/semigrp/ouro && cd ouro
pnpm install
pnpm test                      # all tests must pass before you rely on the CLI
npm link                       # puts `ouro` on PATH

# receiver wiring (requires a Bouro checkout set up per its AGENTS.md)
export BOURO_BIN="$(which bouro)"
export BOURO_VAULT="$HOME/path/of/your/choice/store.json"   # add both to your shell profile

ouro demo                      # golden path against a static context; must end succeeded
ouro doctor                    # verifies store structure, event chain, snapshots
```

The engine store defaults to `.ouro/store.json` under the current directory (one store per
project checkout; override with `--store`). Run artifacts live under `.ouro/artifacts`.

First real Run: follow [examples/quality-gate](examples/quality-gate/README.md) — it takes a
repository you already have, vendors the gate procedure into it, and executes its declared
quality gates as a pinned Run with Evidence delivery and Fukuro export.

## Conventions an agent must follow

1. **Procedure bytes are repository-owned.** An artifact must resolve inside the workspace; vendor
   the procedure into the target repository and pin it (HEAD commit + sha256). Never point a Run
   at bytes outside the workspace — Ouro will refuse, and the refusal is correct.
2. **Tiers are declarations, made honestly.** `inspect` for read-only procedures,
   `workspace-write` when commands write inside the workspace (caches, build output),
   `external-write` beyond that. A tier is not a sandbox: never run untrusted artifacts on the
   strength of a tier alone.
3. **Gates decide; agents do not.** A Run's outcome is its gate results. Do not mark work done in
   any downstream system unless the Run's gates passed.
4. **Telemetry goes through the export.** `ouro events export --target fukuro [--run RUN-n]`
   piped to `fukuro import` — never hand-write telemetry rows for something Ouro executed.
   Re-export is safe: `sourceEventId` makes imports idempotent.
5. **Evidence goes through the outbox.** A completed Run stays complete when delivery fails;
   `ouro bouro flush` replays with the same idempotency key. Never register Run evidence in Bouro
   by hand.
6. **Pin, don't improvise.** If the run request needs values you do not have (experiment id,
   procedure id, digests), create or look them up — never guess a version or digest.

## What must never happen

- Executing a procedure whose digest does not match its pinned artifact (Ouro enforces this;
  do not work around it).
- Shell pipelines or interpolated commands inside procedures — spawn argv arrays only.
- Secrets or third-party personal data in run inputs, gate output, or telemetry. Telemetry is
  field-whitelisted and URI-stripped by design; keep it that way.

## CLI cheat sheet

```bash
ouro init | doctor | status [--store <path>]
ouro run --spec <run-request.json> [--allow-tier workspace-write]
ouro show --run RUN-n
ouro prepare --work "owner/repo#123" --title "repo gates" --workspace /abs/target \
  --commands '[["npx","tsc"],["npm","test"]]'   # find-or-create Bouro chain, save .ouro/requests/<slug>.json
ouro events export --target fukuro [--since EVT-n] [--run RUN-n]
ouro bouro flush
node examples/quality-gate/make-run-request.mjs --work "owner/repo#123" \
  --workspace /abs/target --commands '[["npx","tsc"],["npm","test"]]' \
  --experiment EXP-n --procedure PROC-n > run-request.json
```

Run `ouro doctor` after anything unusual; it must stay `ok: true`.
