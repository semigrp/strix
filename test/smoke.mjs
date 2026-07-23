// Smoke test: gate (green/red) -> marker semantics -> pregate deny/allow -> emit contract.
import { execSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const CLI = join(ROOT, 'cli', 'strix.ts');
const TMP = join(HERE, '.tmp');
rmSync(TMP, { recursive: true, force: true });

const sh = (cmd, opts = {}) => execSync(cmd, { stdio: ['pipe', 'pipe', 'pipe'], ...opts }).toString();

// --- fixture repo ---
const repo = join(TMP, 'demo');
mkdirSync(repo, { recursive: true });
sh(`git -C ${repo} init -q && git -C ${repo} -c user.email=t@t -c user.name=t commit -q --allow-empty -m init`);
writeFileSync(join(repo, '.strix.json'), JSON.stringify({ gates: ['node -e "process.exit(0)"'] }));
const gitDir = sh(`git -C ${repo} rev-parse --absolute-git-dir`).trim();
const sha = sh(`git -C ${repo} rev-parse HEAD`).trim();

// --- pregate: push without marker -> deny ---
const hookInput = (command) => JSON.stringify({ tool_input: { command }, cwd: repo });
let r = spawnSync('node', [CLI, 'pregate'], { input: hookInput('git push origin main') });
let out = r.stdout.toString();
assert.match(out, /"permissionDecision":\s*"deny"|"deny"/, 'ungated push must be denied');

// --- dry-run and non-push pass through ---
for (const c of ['git push --dry-run', 'git status', 'ls']) {
  r = spawnSync('node', [CLI, 'pregate'], { input: hookInput(c) });
  assert.strictEqual(r.stdout.toString().trim(), '', `must stay silent for: ${c}`);
}

// --- gate green -> marker = HEAD, record written ---
r = spawnSync('node', [CLI, 'gate', repo]);
assert.strictEqual(r.status, 0, 'green gate must exit 0');
assert.strictEqual(readFileSync(join(gitDir, 'strix-gate-pass'), 'utf8').trim(), sha);
const rec = JSON.parse(readFileSync(join(gitDir, 'strix-last-gate.json'), 'utf8'));
assert.strictEqual(rec.result, 'passed');

// --- pregate after green gate -> allow ---
r = spawnSync('node', [CLI, 'pregate'], { input: hookInput('git push origin main') });
assert.strictEqual(r.stdout.toString().trim(), '', 'gated push must be allowed');

// --- git -C form is parsed ---
r = spawnSync('node', [CLI, 'pregate'], { input: JSON.stringify({ tool_input: { command: `git -C ${repo} push` }, cwd: '/' }) });
assert.strictEqual(r.stdout.toString().trim(), '', 'git -C gated push must be allowed');

// --- new commit invalidates the marker ---
sh(`git -C ${repo} -c user.email=t@t -c user.name=t commit -q --allow-empty -m next`);
r = spawnSync('node', [CLI, 'pregate'], { input: hookInput('git push') });
assert.match(r.stdout.toString(), /deny/, 'stale marker must not authorize a new HEAD');

// --- gate red -> exit 1, no marker for new HEAD, failure recorded ---
writeFileSync(join(repo, '.strix.json'), JSON.stringify({ gates: ['node -e "process.exit(1)"'] }));
r = spawnSync('node', [CLI, 'gate', repo]);
assert.strictEqual(r.status, 1, 'red gate must exit 1');
const sha2 = sh(`git -C ${repo} rev-parse HEAD`).trim();
assert.notStrictEqual(readFileSync(join(gitDir, 'strix-gate-pass'), 'utf8').trim(), sha2);
assert.strictEqual(JSON.parse(readFileSync(join(gitDir, 'strix-last-gate.json'), 'utf8')).result, 'failed');

// --- emit: valid fukuro.telemetry-event/v1 ---
const e = JSON.parse(spawnSync('node', [CLI, 'emit', repo]).stdout.toString());
for (const k of ['schema', 'source', 'sourceEventId', 'occurredAt', 'kind', 'subject', 'refs', 'data'])
  assert.ok(k in e, `emit missing ${k}`);
assert.strictEqual(e.schema, 'fukuro.telemetry-event/v1');
assert.strictEqual(e.source, 'strix');
assert.strictEqual(e.kind, 'strix_gate_failed');
assert.strictEqual(e.refs[0].id, sha2);

// --- legacy exact-HEAD marker remains readable ---
unlinkSync(join(gitDir, 'strix-gate-pass'));
writeFileSync(join(gitDir, 'ouro-gate-pass'), sha2 + '\n');
r = spawnSync('node', [CLI, 'pregate'], { input: hookInput('git push') });
assert.strictEqual(r.stdout.toString().trim(), '', 'legacy exact-HEAD marker must remain valid');

// --- legacy gate records retain their Ouro wire identity on re-emit ---
const legacyRecord = JSON.parse(readFileSync(join(gitDir, 'strix-last-gate.json'), 'utf8'));
delete legacyRecord.producer;
writeFileSync(join(gitDir, 'ouro-last-gate.json'), JSON.stringify(legacyRecord));
unlinkSync(join(gitDir, 'strix-last-gate.json'));
const legacyEvent = JSON.parse(spawnSync('node', [CLI, 'emit', repo]).stdout.toString());
assert.strictEqual(legacyEvent.source, 'ouro');
assert.strictEqual(legacyEvent.kind, 'ouro_gate_failed');

// --- legacy config remains a fallback ---
unlinkSync(join(repo, '.strix.json'));
writeFileSync(join(repo, '.ouro.json'), JSON.stringify({ gates: ['node -e "process.exit(0)"'] }));
r = spawnSync('node', [CLI, 'gate', repo]);
assert.strictEqual(r.status, 0, 'legacy config must remain readable');

// --- guard log via STRIX_GUARD_LOG ---
const glog = join(TMP, 'guard.jsonl');
sh(`git -C ${repo} -c user.email=t@t -c user.name=t commit -q --allow-empty -m guard-log`);
spawnSync('node', [CLI, 'pregate'], { input: hookInput('git push'), env: { ...process.env, STRIX_GUARD_LOG: glog } });
assert.ok(existsSync(glog) && readFileSync(glog, 'utf8').includes('pre-push-gate'));

// --- OURO_GUARD_LOG remains a fallback ---
const legacyLog = join(TMP, 'legacy-guard.jsonl');
spawnSync('node', [CLI, 'pregate'], { input: hookInput('git push'), env: { ...process.env, OURO_GUARD_LOG: legacyLog } });
assert.ok(existsSync(legacyLog) && readFileSync(legacyLog, 'utf8').includes('pre-push-gate'));

rmSync(TMP, { recursive: true, force: true });
console.log('smoke: ok');
