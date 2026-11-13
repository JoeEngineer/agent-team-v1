// Codex side of the live CI harness: installs the plugin under test into a throwaway
// CODEX_HOME the way tests/live/codex-live.js does (marketplace add, plugin add,
// codex-agents.js, codex-hooks.js, hook trust recorded from `codex app-server`
// hooks/list), then finds the Director's rollout after the run. Node built-ins only.
// codex-live.js is left as it is; only its pickVersion helper is reused.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { pickVersion } = require('./codex-live.js');
const { isDirectorRollout } = require('./ci-turns.js');

const WIN = process.platform === 'win32';
const fwd = (p) => p.replace(/\\/g, '/');
const q = (a) => (WIN && /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
// One command line for the shell: claude and codex are .cmd shims on Windows, and an args
// array together with shell:true is deprecated in new Node versions.
const shellLine = (cmd, args) => [cmd, ...args.map(q)].join(' ');

// Minimal JSON-RPC over stdio to `codex app-server` (same protocol as codex-live.js).
function appServer(env, method, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    const p = WIN ? spawn(shellLine('codex', ['app-server']), { env, shell: true, windowsHide: true }) : spawn('codex', ['app-server'], { env, windowsHide: true });
    let buf = '';
    const t = setTimeout(() => { p.kill(); reject(new Error('codex app-server timeout')); }, timeoutMs || 60000);
    const send = (o) => p.stdin.write(JSON.stringify(o) + '\n');
    p.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch (e) { continue; }
        if (m.id === 1) { send({ method: 'initialized' }); send({ id: 2, method, params }); }
        else if (m.id === 2) { clearTimeout(t); p.kill(); if (m.error) reject(new Error(JSON.stringify(m.error))); else resolve(m.result); }
      }
    });
    p.on('error', (e) => { clearTimeout(t); reject(e); });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'agent-team-live', version: '0' } } });
  });
}

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

// Installs everything into `home` for the project folder `clone`. `run(cmd, args, opts)` is the
// harness's spawnSync wrapper. Returns { ok, steps: [{name, ok, detail}], hooks }.
async function install({ plugin, home, clone, env, run, realAuth }) {
  const steps = [];
  const step = (name, ok, detail) => { steps.push({ name, ok: !!ok, detail: detail || '' }); return !!ok; };
  fs.mkdirSync(home, { recursive: true });
  // Credentials go into the throwaway home only; the harness removes them at cleanup.
  fs.copyFileSync(realAuth, path.join(home, 'auth.json'));
  const baseCfg = `[projects.'${clone}']\ntrust_level = "trusted"\n`;
  fs.writeFileSync(path.join(home, 'config.toml'), baseCfg);
  const codex = (args, o) => run('codex', args, Object.assign({ env }, o));
  const tail = (r) => (r.stderr || r.stdout || '').trim().slice(0, 200);
  let r = codex(['plugin', 'marketplace', 'add', plugin]);
  if (!step('codex plugin marketplace add', r.status === 0, tail(r))) return { ok: false, steps };
  r = codex(['plugin', 'add', 'agent-team@agent-team']);
  if (!step('codex plugin add', r.status === 0, tail(r))) return { ok: false, steps };
  const cacheRoot = path.join(home, 'plugins', 'cache', 'agent-team', 'agent-team');
  let want = null;
  try { want = JSON.parse(fs.readFileSync(path.join(plugin, '.claude-plugin', 'plugin.json'), 'utf8')).version; } catch (e) { /* highest */ }
  const ver = fs.existsSync(cacheRoot) ? pickVersion(fs.readdirSync(cacheRoot), want) : null;
  if (!step('plugin cache folder', !!ver, ver ? `${ver}` : 'missing')) return { ok: false, steps };
  r = run('node', [path.join(plugin, 'scripts', 'codex-agents.js')], { cwd: clone, env });
  if (!step('codex-agents.js', r.status === 0, tail(r))) return { ok: false, steps };
  r = run('node', [path.join(plugin, 'scripts', 'codex-hooks.js')], { cwd: clone, env });
  if (!step('codex-hooks.js', r.status === 0, tail(r))) return { ok: false, steps };
  let listed;
  try { listed = projectHooks(await appServer(env, 'hooks/list', { cwds: [fwd(clone)] })); } catch (e) { step('trust: hooks/list', false, e.message); return { ok: false, steps }; }
  if (!step('trust: project hooks listed', listed.length > 0, `${listed.length} hooks`)) return { ok: false, steps };
  let cfg = baseCfg;
  for (const h of listed) cfg += `\n[hooks.state.'${h.key}']\ntrusted_hash = "${h.currentHash}"\n`;
  fs.writeFileSync(path.join(home, 'config.toml'), cfg);
  return { ok: true, steps, hooks: listed.length, pluginVersion: ver };
}

// All rollout files under the home's sessions folder.
function rolloutFiles(home) {
  const out = [];
  const walk = (d) => {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/^rollout-.*\.jsonl$/.test(e.name)) out.push(p);
    }
  };
  walk(path.join(home, 'sessions'));
  return out;
}
// The Director's rollout: the largest one that is not a subagent's. Returns { file, text } or null.
function directorRollout(home) {
  let best = null;
  for (const f of rolloutFiles(home)) {
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch (e) { continue; }
    const head = text.split('\n', 5).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
    if (!isDirectorRollout(head)) continue;
    if (!best || text.length > best.text.length) best = { file: f, text };
  }
  return best;
}

function execArgs({ clone, model }) {
  const a = ['exec', '--json', '--dangerously-bypass-approvals-and-sandbox', '-C', fwd(clone)];
  if (model) a.push('-m', model);
  a.push('-');
  return a;
}

module.exports = { install, directorRollout, rolloutFiles, execArgs, appServer, projectHooks, fwd, q, shellLine, WIN };
