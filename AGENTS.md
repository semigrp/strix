# AGENTS.md

Operating notes for AI agents working in a repository guarded by ouro.

## The one rule

An ungated HEAD does not push. Before any `git push`:

1. Run `ouro gate <repoDir>` **as its own command** and confirm every gate is green.
2. Push **as a separate command**. Never chain them (`gate && push` masks the exit code
   the guard exists to protect — the pregate hook will still stop you, but don't try).
3. After a green gate, optionally deliver evidence: `ouro emit <repoDir> | fukuro import`.

If the pregate hook denies your push: the current HEAD has not passed. Run the gate.
If the gate is red, fix the code — do not amend markers, do not look for bypasses.
If you believe the push must happen without gates, stop and ask the human.

## Gate definition

Prefer the repo's own `.ouro.json` (`{"gates": [...]}`). Without it, ouro derives gates
from package.json scripts (typecheck / lint / build / test). If the automatic detection
runs the wrong thing (e.g. a test script that needs arguments), add `.ouro.json` — do not
work around it in your own shell.

## Setup from a fresh clone

```
node cli/ouro.ts            # help
node test/smoke.mjs         # verify (creates a throwaway git repo under test/.tmp)
ouro hooks                  # print the settings.json wiring for Claude Code
```

Zero dependencies; Node ≥ 24 runs the TypeScript directly. Nothing here requires private
context; instance-specific gate lists and guard logs stay in each repository and are never
committed to this one.
