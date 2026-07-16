# ADR 0002: Refound ouro as the pre-push checkpoint; delete the execution engine

- Status: Accepted (supersedes ADR 0001)
- Date: 2026-07-17

## Context

ADR 0001 defined ouro as a local-first outbound execution engine: Work → Plan → Task →
ContextBundle → ProcedureBinding → Run → Attempt → Gate → Result, driven by run-request
files, with permission tiers and workspace containment.

Empirical record after three days of real use:

- Engine runs outside demos: **one**. In every real implementation loop the operator and
  the agent bypassed ouro and ran the repo's gates directly — authoring a run-request
  before any value appears is a manual write path, and manual write paths starve
  (fukuro ADR 0001; reconfirmed quantitatively by a 602-utterance correction analysis).
- Meanwhile two ~60-line hook scripts implementing only the essential invariant —
  a commit-pinned "all gates green" marker plus a PreToolUse guard denying ungated
  pushes — fired daily, survived worktrees, and blocked real gate-skipping attempts
  (3 recorded stop-line hits). Their only defect was having no maintained, shareable home.

## Decision

ouro v0.2 keeps the checkpoint and deletes everything else.

- **Keep**: gate execution with inherited stdio (exit codes never masked), the
  commit-pinned marker, the pregate guard (fail-open for non-push/dry-run/no-git,
  fail-closed for ungated HEADs), and gate evidence via the vendored
  `fukuro.telemetry-event/v1` contract.
- **Delete**: run-requests, the eight-stage execution ontology, permission tiers,
  adapters, the build step, and the `prepare` ceremony. The noun-store chain that
  `prepare` built by hand is junro/negura's job now.
- **Boundary**: gates are defined by the repository (`.ouro.json` or its scripts);
  history is fukuro's; policy vocabulary is the noun store's. ouro holds exactly one
  invariant: *no commit leaves without this exact HEAD having passed.*

## Consequences

- Adoption is one hook line and zero new rituals; the write path (the push you were
  already doing) is automatic.
- The engine's reproducibility guarantees (pinned procedure bytes, replayable runs) are
  given up. If provenance stronger than "commands list + sha256 digest + commit sha" is
  ever needed, that is a new decision, not a revival of the old engine.
- v0.1's history remains in git; this ADR supersedes ADR 0001 rather than rewriting it.
