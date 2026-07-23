#!/usr/bin/env node
// Strix — the owl at the checkpoint before the outbound leg:
// run the repository's quality gates exactly once, deterministically, with
// evidence — and refuse the push when HEAD never passed.
//
// Owns exactly one job: no commit leaves without a green, commit-pinned gate.
// Everything else is delegated: event ledger -> fukuro (vendored
// telemetry-event contract), policy vocabulary -> the user's noun store,
// execution -> the repo's own scripts. No run-requests, no ceremony.
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, basename } from 'node:path';

const MARKER = 'strix-gate-pass';
const LEGACY_MARKER = 'ouro-gate-pass';
const LAST = 'strix-last-gate.json';
const LEGACY_LAST = 'ouro-last-gate.json';

// ---------- git context ----------
interface Ctx { root: string; sha: string; gitDir: string }
function gitCtx(dir: string): Ctx | null {
  try {
    const root = execSync(`git -C "${dir}" rev-parse --show-toplevel`, { encoding: 'utf8' }).trim();
    const sha = execSync(`git -C "${root}" rev-parse HEAD`, { encoding: 'utf8' }).trim();
    // In a worktree .git is a file; the marker must live in the real git dir.
    const gitDir = execSync(`git -C "${root}" rev-parse --absolute-git-dir`, { encoding: 'utf8' }).trim();
    return { root, sha, gitDir };
  } catch { return null; }
}

// ---------- gate command discovery ----------
// 1) <repo>/.strix.json {"gates": ["<full shell command>", ...]} — the canon
//    .ouro.json remains a read-only compatibility fallback.
// 2) package.json scripts: typecheck / lint / build / test (pnpm/yarn/npm detected)
function detectGates(root: string): string[] {
  const configNames = existsSync(join(root, '.strix.json')) ? ['.strix.json'] : ['.ouro.json'];
  for (const name of configNames) {
    const cfg = join(root, name);
    if (existsSync(cfg)) {
      try {
        const g = JSON.parse(readFileSync(cfg, 'utf8')).gates;
        if (Array.isArray(g) && g.length) return g;
      } catch { /* broken config falls through to detection */ }
    }
  }
  const pkgPath = join(root, 'package.json');
  if (!existsSync(pkgPath)) return [];
  let scripts: Record<string, string> = {};
  try { scripts = JSON.parse(readFileSync(pkgPath, 'utf8')).scripts ?? {}; } catch { /* noop */ }
  const pm = existsSync(join(root, 'pnpm-lock.yaml')) ? 'npx -y pnpm@10 run'
    : existsSync(join(root, 'yarn.lock')) ? 'yarn'
    : 'npm run';
  return ['typecheck', 'lint', 'build', 'test'].filter((s) => scripts[s]).map((s) => `${pm} ${s}`);
}

const digest = (v: unknown): string =>
  `sha256:${createHash('sha256').update(JSON.stringify(v)).digest('hex')}`;

// ---------- gate ----------
// Runs every gate with stdio inherited — no pipes, no masked exit codes.
// Green: write <gitDir>/strix-gate-pass = HEAD sha. Red: no marker, exit 1.
// Either way <gitDir>/strix-last-gate.json records what ran, for `strix emit`.
function cmdGate(dir: string): void {
  const ctx = gitCtx(dir);
  if (!ctx) { console.error(`strix gate: not a git repository: ${dir}`); process.exit(2); }
  const gates = detectGates(ctx.root);
  if (!gates.length) {
    console.error('strix gate: no gates found (.strix.json {"gates":[...]} or package.json scripts required)');
    process.exit(2);
  }
  console.error(`strix gate: ${ctx.root} @ ${ctx.sha.slice(0, 8)} — ${gates.length} gate(s)`);
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  let failed: string | null = null;
  for (const cmd of gates) {
    console.error(`\n▶ ${cmd}`);
    try {
      execSync(cmd, { cwd: ctx.root, stdio: 'inherit' });
    } catch { failed = cmd; break; }
  }
  const record = {
    producer: 'strix',
    repo: basename(ctx.root), root: ctx.root, sha: ctx.sha,
    gates, gatesDigest: digest(gates),
    result: failed ? 'failed' : 'passed', failedCommand: failed,
    occurredAt: startedAt, durationMs: Date.now() - t0,
  };
  writeFileSync(join(ctx.gitDir, LAST), JSON.stringify(record, null, 2) + '\n');
  if (failed) {
    console.error(`\n✗ gate failed: ${failed} — no marker written (push stays blocked)`);
    process.exit(1);
  }
  writeFileSync(join(ctx.gitDir, MARKER), ctx.sha + '\n');
  console.error(`\n✓ all gates green. marker: ${join(ctx.gitDir, MARKER)} = ${ctx.sha.slice(0, 8)}`);
}

// ---------- pregate (PreToolUse hook) ----------
// stdin: Claude Code PreToolUse JSON. Denies `git push` when HEAD does not
// match the marker. Fail-open on anything that is not clearly an ungated push
// (no git context / not a push / --dry-run).
function cmdPregate(): void {
  let raw = '';
  try { raw = readFileSync(0, 'utf8'); } catch { /* no stdin */ }
  let inp: any = {};
  try { inp = JSON.parse(raw); } catch { /* not JSON */ }
  const command: string = inp?.tool_input?.command ?? '';
  const cwd: string = inp?.cwd || process.cwd();
  if (!command) process.exit(0);
  if (!/\bgit\s+push\b/.test(command) || /--dry-run\b/.test(command)) process.exit(0);

  const cflag = command.match(/\bgit\s+-C\s+("[^"]+"|\S+)\s+push/);
  const dir = cflag ? cflag[1].replace(/^"|"$/g, '') : cwd;
  const ctx = gitCtx(dir);
  if (!ctx) process.exit(0); // no git context — stay out of the way

  const markerPaths = [join(ctx.gitDir, MARKER), join(ctx.gitDir, LEGACY_MARKER)];
  const passed = markerPaths
    .filter((path) => existsSync(path))
    .map((path) => readFileSync(path, 'utf8').trim())
    .find((sha) => sha === ctx.sha) ?? '';
  if (passed === ctx.sha) process.exit(0);

  const log = process.env.STRIX_GUARD_LOG ?? process.env.OURO_GUARD_LOG;
  if (log) {
    try {
      mkdirSync(dirname(log), { recursive: true });
      appendFileSync(log, JSON.stringify({
        ts: new Date().toISOString(),
        session: process.env.CLAUDE_CODE_SESSION_ID ?? null,
        slug: 'pre-push-gate', action: 'deny', command: command.slice(0, 300),
      }) + '\n');
    } catch { /* logging must never break the guard */ }
  }
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        `pre-push gate: HEAD ${ctx.sha.slice(0, 8)} has not passed the quality gates ` +
        `(marker=${passed.slice(0, 8) || 'none'}). Run \`node ${process.argv[1]} gate ${ctx.root}\` in its own ` +
        `command, confirm all gates are green, then push. Never chain gate and push in one ` +
        `command. If you must push without gates, ask the human.`,
    },
  }));
  process.exit(0);
}

// ---------- emit ----------
// Prints the last gate record as one fukuro.telemetry-event/v1 NDJSON line
// (vendored contract: contracts/). Pipe into `fukuro import` — idempotent on
// New records use source=strix. Legacy ouro records retain their old wire identity,
// preventing a re-emit after upgrade from duplicating Fukuro history.
function cmdEmit(dir: string): void {
  const ctx = gitCtx(dir);
  if (!ctx) { console.error(`strix emit: not a git repository: ${dir}`); process.exit(2); }
  const currentPath = join(ctx.gitDir, LAST);
  const legacyPath = join(ctx.gitDir, LEGACY_LAST);
  const path = existsSync(currentPath) ? currentPath : legacyPath;
  if (!existsSync(path)) { console.error('strix emit: no gate record (run `strix gate` first)'); process.exit(2); }
  const r = JSON.parse(readFileSync(path, 'utf8'));
  const source = r.producer === 'strix' || path === currentPath ? 'strix' : 'ouro';
  console.log(JSON.stringify({
    schema: 'fukuro.telemetry-event/v1',
    source,
    sourceEventId: `${r.repo}:${r.sha}:${r.result}`,
    occurredAt: r.occurredAt,
    kind: `${source}_gate_${r.result}`,
    subject: { system: source, type: 'repository', id: r.repo, version: '1' },
    refs: [{ system: 'git', type: 'commit', id: r.sha, version: '1' }],
    data: { gates: r.gates, gatesDigest: r.gatesDigest, durationMs: r.durationMs, failedCommand: r.failedCommand },
  }));
}

// ---------- hooks ----------
// Paste-ready Claude Code settings.json snippet for the PreToolUse guard.
function cmdHooks(): void {
  const self = process.argv[1];
  console.log(JSON.stringify({
    hooks: {
      PreToolUse: [{
        matcher: 'Bash',
        hooks: [{ type: 'command', command: `node ${self} pregate` }],
      }],
    },
  }, null, 2));
}

const HELP = `strix — the owl at the checkpoint before the outbound leg (gate / pregate / emit / hooks)

  strix gate [repoDir]     run the repo's gates; green -> commit-pinned marker, red -> exit 1
  strix pregate            PreToolUse hook: deny \`git push\` when HEAD has no green marker
  strix emit [repoDir]     print the last gate record as fukuro.telemetry-event/v1 (| fukuro import)
  strix hooks              print the Claude Code settings.json wiring

  Gate discovery: <repo>/.strix.json {"gates": [...]}, legacy .ouro.json, else package.json scripts
  (typecheck/lint/build/test; pnpm/yarn/npm detected). Run gate and push as
  SEPARATE commands — chaining them masks the exit code the guard exists to protect.
`;

const [, , cmd, arg] = process.argv;
switch (cmd) {
  case 'gate': cmdGate(arg || process.cwd()); break;
  case 'pregate': cmdPregate(); break;
  case 'emit': cmdEmit(arg || process.cwd()); break;
  case 'hooks': cmdHooks(); break;
  default: console.log(HELP);
}
