#!/usr/bin/env node
// Opt-in live test: installs this plugin into a throwaway CODEX_HOME and runs the
// Codex Director path with one real `codex exec`. NOT part of `node tests/run.js`
// (run.js only loads tests/*.test.js). See tests/live/README.md. Node built-ins only.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const WIN = process.platform === 'win32';
const fwd = (p) => p.replace(/\\/g, '/');
const rows = [];
// known=true: a documented limitation; reported as KNOWN-LIMITATION when it fails, never affects the exit code.
const row = (name, ok, detail, known) => rows.push({ name, ok, detail: detail || '', known: !!known });
const KNOWN_REF = 'skills/director/references/codex.md';
const label = (x) => (x.ok ? 'PASS' : x.known ? 'KNOWN-LIMITATION' : 'FAIL');
const exitCode = (rs) => (rs.some((x) => !x.ok && !x.known) ? 1 : 0);

// Idempotent, scoped cleanup: only removes <base>/<digits> (the harness's own per-pid dir).
let cleaned = false;
function cleanupTemp(tmp, base) {
  if (cleaned) return false;
  const t = path.resolve(tmp);
  if (path.resolve(path.dirname(t)) !== path.resolve(base) || !/^\d+$/.test(path.basename(t))) return false;
  cleaned = true;
  try { fs.rmSync(path.join(t, 'h', 'auth.json'), { force: true }); } catch (e) { /* ignore */ }
  try { fs.rmSync(t, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch (e) { console.log(`cleanup incomplete: ${t}`); }
  try { fs.rmdirSync(base); } catch (e) { /* not empty or gone */ }
  return true;
}
// Preferred version if present, else highest semver; non-semver names sort last.
function pickVersion(names, preferred) {
  if (preferred && names.includes(preferred)) return preferred;
  const key = (n) => (/^(\d+)\.(\d+)\.(\d+)/.exec(n) || [0, -1, -1, -1]).slice(1).map(Number);
  return names.slice().sort((a, b) => { const x = key(a), y = key(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return y[i] - x[i]; return 0; })[0] || null;
}
if (require.main !== module) { module.exports = { row, rows, label, exitCode, cleanupTemp, pickVersion }; return; }
const skip = (msg) => { console.log(`SKIP: ${msg}`); process.exit(0); };

const q = (a) => (WIN && /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
function run(cmd, args, opts) {
  return spawnSync(cmd, WIN ? args.map(q) : args, Object.assign({ encoding: 'utf8', shell: WIN, windowsHide: true }, opts));
}

// ---- preconditions (skip, not fail) ----
if (run('codex', ['--version']).status !== 0) skip('codex is not on PATH');
const small = run('node', [path.join(REPO, 'scripts', 'models.js'), 'resolve', 'small', '--tool', 'codex']);
let MODEL = null;
try { const j = JSON.parse(small.stdout); if (j.enabled && j.model) MODEL = j.model; } catch (e) { /* no tier */ }
if (!MODEL) skip('the model map has no Codex small tier');
const REAL_AUTH = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json');
if (!fs.existsSync(REAL_AUTH)) skip(`no Codex auth available (${REAL_AUTH} not found)`);

const BASE = process.env.AGENT_TEAM_LIVE_TMP || (WIN ? 'C:\\cx2' : path.join(os.tmpdir(), 'cx2'));
const TMP = path.join(BASE, String(process.pid));
const HOME = path.join(TMP, 'h');
const PROJ = path.join(TMP, 'p');
const BARE = path.join(TMP, 'o.git');
const SANDBOX_MODE = process.env.CODEX_LIVE_WINDOWS_SANDBOX || 'unelevated';
const env = Object.assign({}, process.env, { CODEX_HOME: fwd(HOME) });
delete env.AGENT_TEAM_TOOL;

const codex = (args, opts) => run('codex', args, Object.assign({ env }, opts));
const git = (cwd, args) => run('git', args, { cwd });
const readJsonl = (f) => {
  try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (e) { return []; }
};

// Minimal JSON-RPC over stdio to `codex app-server`.
function appServer(method, params) {
  return new Promise((resolve, reject) => {
    const p = spawn('codex', ['app-server'], { env, shell: WIN, windowsHide: true });
    let buf = '';
    const t = setTimeout(() => { p.kill(); reject(new Error('app-server timeout')); }, 60000);
    const send = (o) => p.stdin.write(JSON.stringify(o) + '\n');
    p.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch (e) { continue; }
        if (m.id === 1) {
          send({ method: 'initialized' });
          send({ id: 2, method, params });
        } else if (m.id === 2) { clearTimeout(t); p.kill(); if (m.error) reject(new Error(JSON.stringify(m.error))); else resolve(m.result); }
      }
    });
    p.on('error', reject);
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'agent-team-live', version: '0' } } });
  });
}

const hookList = () => appServer('hooks/list', { cwds: [fwd(PROJ)] });
function projectHooks(res) {
  const out = [];
  const walk = (o) => {
    if (Array.isArray(o)) return o.forEach(walk);
    if (o && typeof o === 'object') {
      if (typeof o.key === 'string' && typeof o.currentHash === 'string') out.push(o);
      Object.values(o).forEach(walk);
    }
  };
  walk(res);
  return out.filter((h) => fwd(h.key).includes('/.codex/hooks.json'));
}

function runExec(prompt, timeoutMs) {
  return new Promise((resolve) => {
    const args = ['exec', '--json', '-m', MODEL, '-c', 'model_reasoning_effort="low"', '--sandbox', 'workspace-write', '-C', fwd(PROJ), '-'];
    const p = spawn('codex', WIN ? args.map(q) : args, { env, shell: WIN, windowsHide: true });
    let out = '', err = '';
    const t = setTimeout(() => { p.kill(); resolve({ out, err, timedOut: true }); }, timeoutMs);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => { clearTimeout(t); resolve({ out, err, code }); });
    p.stdin.end(prompt);
  });
}

async function main() {
  fs.mkdirSync(HOME, { recursive: true });
  // A team-init'd project has .agent-team/; session-start only writes hooks-alive.json where it exists.
  fs.mkdirSync(path.join(PROJ, '.agent-team'), { recursive: true });
  git(TMP, ['init', '--bare', '-q', BARE]);
  git(PROJ, ['init', '-q', '-b', 'main']);
  git(PROJ, ['config', 'user.email', 'live@example.invalid']);
  git(PROJ, ['config', 'user.name', 'live']);
  fs.writeFileSync(path.join(PROJ, 'README.md'), 'live test\n');
  git(PROJ, ['add', 'README.md']);
  git(PROJ, ['commit', '-q', '-m', 'init']);
  git(PROJ, ['remote', 'add', 'origin', BARE]);
  // Credentials go into the throwaway home only; removed at cleanup.
  fs.copyFileSync(REAL_AUTH, path.join(HOME, 'auth.json'));
  const baseCfg = `[windows]\nsandbox = "${SANDBOX_MODE}"\n\n[projects.'${PROJ}']\ntrust_level = "trusted"\n`;
  fs.writeFileSync(path.join(HOME, 'config.toml'), baseCfg);

  let r = codex(['plugin', 'marketplace', 'add', REPO]);
  row('marketplace add', r.status === 0, (r.stderr || '').trim().slice(0, 200));
  r = codex(['plugin', 'add', 'agent-team@agent-team']);
  row('plugin add', r.status === 0, (r.stderr || '').trim().slice(0, 200));
  if (rows.some((x) => !x.ok)) return;
  const cacheRoot = path.join(HOME, 'plugins', 'cache', 'agent-team', 'agent-team');
  let want = null;
  try { want = JSON.parse(fs.readFileSync(path.join(REPO, '.claude-plugin', 'plugin.json'), 'utf8')).version; } catch (e) { /* fall back to highest */ }
  const ver = fs.existsSync(cacheRoot) ? pickVersion(fs.readdirSync(cacheRoot), want) : null;
  const PLUGIN = ver ? path.join(cacheRoot, ver) : null;
  row('plugin cache folder exists', !!PLUGIN, PLUGIN ? '' : 'missing');
  if (!PLUGIN) return;

  r = run('node', [path.join(REPO, 'scripts', 'codex-agents.js')], { cwd: PROJ, env });
  row('codex-agents.js', r.status === 0, (r.stderr || '').trim().slice(0, 200));
  r = run('node', [path.join(REPO, 'scripts', 'codex-hooks.js')], { cwd: PROJ, env });
  row('codex-hooks.js', r.status === 0, (r.stderr || '').trim().slice(0, 200));
  const hooksFile = path.join(PROJ, '.codex', 'hooks.json');
  const bytes1 = fs.existsSync(hooksFile) ? fs.readFileSync(hooksFile) : null;

  // Trust: hash from hooks/list -> [hooks.state] in the temp config.toml.
  let listed;
  try { listed = projectHooks(await hookList()); } catch (e) { row('trust: hooks/list', false, e.message); return; }
  if (!listed.length) { row('trust: hooks/list returned project hooks', false, 'none found'); return; }
  let cfg = baseCfg;
  for (const h of listed) cfg += `\n[hooks.state.'${h.key}']\ntrusted_hash = "${h.currentHash}"\n`;
  fs.writeFileSync(path.join(HOME, 'config.toml'), cfg);
  const hashes1 = Object.fromEntries(listed.map((h) => [h.key, h.currentHash]));
  row('trust: recorded hook hashes', true, `${listed.length} hooks`);

  // (b) re-running codex-hooks.js leaves bytes and hashes unchanged.
  run('node', [path.join(REPO, 'scripts', 'codex-hooks.js')], { cwd: PROJ, env });
  const same = !!bytes1 && Buffer.compare(bytes1, fs.readFileSync(hooksFile)) === 0;
  let hashes2 = {};
  try { hashes2 = Object.fromEntries(projectHooks(await hookList()).map((h) => [h.key, h.currentHash])); } catch (e) { /* row fails below */ }
  row('(b) trust hash stable after re-running codex-hooks.js', same && JSON.stringify(hashes1) === JSON.stringify(hashes2),
    `file identical: ${same}`);

  const LE = `node "${fwd(PLUGIN)}/scripts/log-event.js" delegation -`;
  // Stdin form of log-event.js (see the Director's codex.md): quoted heredoc in sh, single-quoted here-string piped in PowerShell.
  const J = (o) => JSON.stringify(o);
  const logCmd = (json) => (WIN ? `@'\n${json}\n'@ | ${LE}` : `${LE} <<'EOF'\n${json}\nEOF`);
  const deleg = (id, name, agent, why) => J({
    tool: 'codex', task_name: name, agent, tier: 'small', effort: 'low', vehicle: 'subagent',
    card: `TASK id=${id} type=test difficulty=low milestone=live attempt=1 tier=small\nWHY ${why}`,
  });
  const prompt = [
    'You are the Director in a live test. Do these steps in order using your shell and spawn tools. Do not skip any.',
    '0. Echo, word for word, the line that starts with "agent-team hooks:" from your session start context (say NONE if absent).',
    `1. Run this shell command (multi-line, keep it exactly):
${logCmd(deleg('LIVE-1', 'live_1_a1', 'scout-small', 'live scout'))}`,
    '2. Spawn an agent with your spawn_agent tool: agent_type "scout-small", task_name "live_1_a1", reasoning_effort "low". Its message: Reply with only a fenced block ```result-json {"status":"done","summary":"live scout ok"} ``` (language tag result-json) and nothing else. Wait for it to finish.',
    `3. Run this shell command (multi-line, keep it exactly):
${logCmd(deleg('LIVE-2', 'live_2_a1', 'reviewer-small', 'live review'))}`,
    '4. Spawn agent_type "reviewer-small", task_name "live_2_a1", reasoning_effort "low". Its message: Do not review anything. Reply with only a fenced block with language tag review-json containing {"verdict":"approve","summary":"canned"}. Wait for it to finish.',
    '5. Run `git push origin main` and quote its output (or the block reason) exactly.',
    '6. Run `git worktree add .agent-team/worktrees/T1 -b task/T1` and quote its output exactly, saying WORKTREE-OK or WORKTREE-FAILED.',
    'Then stop.',
  ].join('\n');
  const res = await runExec(prompt, 15 * 60 * 1000);
  const all = res.out + '\n' + res.err;
  row('codex exec finished', !res.timedOut && res.code === 0, res.timedOut ? 'timed out' : `exit ${res.code}`);

  const logs = path.join(PROJ, '.agent-team', 'logs');
  const dels = readJsonl(path.join(logs, 'delegations.jsonl'));
  const withSrc = (n, s) => dels.filter((d) => d.task_name === n && d.source === s);
  row('delegations: one Director line each for live_1_a1, live_2_a1',
    withSrc('live_1_a1', 'director').length === 1 && withSrc('live_2_a1', 'director').length === 1, `${dels.length} lines`);
  row('delegations: no duplicate hook line for the same task_name',
    withSrc('live_1_a1', 'hook').length === 0 && withSrc('live_2_a1', 'hook').length === 0);
  const comps = readJsonl(path.join(logs, 'completions.jsonl'));
  const c1 = comps.find((c) => c.task_name === 'live_1_a1');
  row('completions: tool codex, mapped model, low effort, tokens>0, parsed result',
    !!c1 && c1.tool === 'codex' && c1.resolved_model === MODEL && c1.resolved_effort === 'low' && c1.tokens > 0 && !!c1.result,
    c1 ? `model ${c1.resolved_model} effort ${c1.resolved_effort} tokens ${c1.tokens} result ${JSON.stringify(c1.result)}` : `no completion line (${comps.length} lines)`);
  const revs = readJsonl(path.join(logs, 'reviews.jsonl'));
  row('reviews: verdict logged', revs.some((x) => x.verdict), `${revs.length} lines`);
  const bareHeads = git(BARE, ['for-each-ref', 'refs/heads']).stdout || '';
  const denied = /agent-team guard blocked/.test(all);
  row('push blocked by guard, bare remote has no main', denied && !/refs\/heads\/main/.test(bareHeads),
    denied ? 'deny reason seen' : 'deny reason NOT seen');
  row('hooks-alive.json exists', fs.existsSync(path.join(logs, '.pending', 'hooks-alive.json')));
  row('model saw "agent-team hooks: active"', /agent-team hooks: active/.test(res.out));
  row('no hook-errors.jsonl', !fs.existsSync(path.join(logs, 'hook-errors.jsonl')));
  const wtOk = fs.existsSync(path.join(PROJ, '.agent-team', 'worktrees', 'T1', '.git'));
  row(`(a) git worktree add in sandbox (windows sandbox=${SANDBOX_MODE}, exec sandbox=workspace-write)`, wtOk, wtOk ? 'worked' : `failed; expected on the unelevated Windows sandbox, see ${KNOWN_REF}`, true);
  const u = /"type":"turn.completed","usage":\{"input_tokens":(\d+),"cached_input_tokens":(\d+).*?"output_tokens":(\d+)/.exec(res.out);
  console.log(`exec runs: 1; parent usage (input/cached/output): ${u ? `${u[1]}/${u[2]}/${u[3]}` : 'n/a'}; model ${MODEL}`);
  if (process.env.CODEX_LIVE_DEBUG) fs.writeFileSync(path.join(os.tmpdir(), 'codex-live-exec.jsonl'), res.out + '\n---stderr---\n' + res.err);
}

const onSignal = (sig) => () => {
  cleanupTemp(TMP, BASE);
  console.log(`interrupted (${sig}); temp folder removed`);
  process.exit(130);
};
process.on('SIGINT', onSignal('SIGINT'));
process.on('SIGTERM', onSignal('SIGTERM'));

(async () => {
  try { await main(); } catch (e) { row('harness error', false, e.message); }
  finally { cleanupTemp(TMP, BASE); }
  console.log('\nResults');
  for (const x of rows) console.log(`${label(x)}  ${x.name}${x.detail ? '  -- ' + x.detail : ''}`);
  process.exit(exitCode(rows));
})();
