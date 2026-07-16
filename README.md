# ouro（往路）

> The outbound leg of a journey is **ōro** (往路) — yes, it still sounds like *ouro*boros.
> ouro is the checkpoint at the start of that leg: **no commit leaves without a green,
> commit-pinned quality gate.**

ouro does exactly one job, in one sentence: *run the repository's quality gates once,
deterministically, with evidence — and refuse the push when HEAD never passed.*

## Why it looks like this (the honest version)

ouro v0.1 was an execution engine: Work → Plan → Task → ContextBundle → ProcedureBinding →
Run → Attempt → Gate → Result, driven by hand-authored run-request files. It worked — and
was used exactly once outside demos. Meanwhile a 120-line pair of hook scripts doing the
same essential job (commit-pinned gate marker + push denial) fired every single day and
caught real gate-skipping attempts.

The lesson is the family's founding principle (fukuro ADR 0001, reconfirmed empirically):
**structures survive only where their write path is automatic; ceremony starves.** So v0.2
deletes the engine and keeps the checkpoint. See
[ADR 0002](docs/adr/0002-refound-as-the-pre-push-checkpoint.md).

## The mechanism

```
ouro gate <repo>     # run gates (stdio inherited — exit codes are never masked)
                     #   green -> <gitdir>/ouro-gate-pass = HEAD sha
                     #   red   -> no marker, exit 1
git push ...         # PreToolUse hook `ouro pregate` denies unless marker == HEAD
ouro emit <repo> | fukuro import    # gate evidence -> the event ledger (idempotent)
```

- **The marker is per-commit.** Any new commit invalidates it. There is no "gates passed
  recently"; only "this exact HEAD passed".
- **Gate and push must be separate commands.** Chaining them (`gate && push`) reintroduces
  the exit-code masking the guard exists to prevent. The deny message says so.
- **Fail-open where it should be**: not a push, `--dry-run`, or no git context — the guard
  stays silent. Fail-closed where it must be: an ungated HEAD never pushes quietly.
- **Worktree-safe**: markers live in the resolved real git dir (`--absolute-git-dir`).

### Gate discovery

1. `<repo>/.ouro.json` — `{"gates": ["<full shell command>", ...]}` — the canon.
2. Otherwise `package.json` scripts `typecheck` / `lint` / `build` / `test`
   (pnpm / yarn / npm detected by lockfile).

### Wiring (Claude Code)

`ouro hooks` prints the paste-ready `settings.json` snippet:

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "node /path/to/ouro/cli/ouro.ts pregate" }] }
    ]
  }
}
```

Optional: set `OURO_GUARD_LOG=<path>` to append a JSONL record of every denial (patrol
material for the return path).

### Evidence

`ouro emit` prints the last gate run as one `fukuro.telemetry-event/v1` line
(`ouro_gate_passed` / `ouro_gate_failed`, with the gate list, its sha256 digest, duration,
and the commit ref). `fukuro import` is idempotent on (source, sourceEventId) =
(`ouro`, `repo:sha:result`) — re-emitting is always safe. Failures are first-class: a
red-then-green pair on the same commit is visible retry history, not noise.

## Division of labor

| Concern | Lives in |
|---|---|
| What the gates are | The repo (`.ouro.json` / its own scripts) |
| Whether HEAD passed | ouro (marker + guard) |
| What happened, over time | [fukuro](https://github.com/semigrp/fukuro) (via the vendored import contract) |
| Why the rule exists | Your noun store (norms with `enforcement: hook`) |

## What ouro is not

- **Not CI.** It runs on your machine, before the push, in seconds. CI remains the
  authority after the push.
- **Not a runner or an orchestrator.** No plans, no tasks, no permission tiers.
- **Not a policy engine.** One rule, hardcoded: ungated HEADs do not leave.

## Status

v0.2 — the refounding. `gate` / `pregate` / `emit` / `hooks`, zero dependencies,
Node ≥ 24 (direct TypeScript execution). The mechanism it packages ran in production
daily for a week before this release and blocked real ungated pushes (3 recorded hits).

## License

[Apache-2.0](LICENSE)
