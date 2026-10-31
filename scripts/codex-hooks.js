#!/usr/bin/env node
// Write the Codex project hooks: .codex/agent-team-hook.js (a small shim) and
// .codex/hooks.json (derived from hooks/hooks.json). The Codex CLI does not run
// plugin hooks, so the project files are what make the guard and logger work
// there. Node built-ins only. See docs/decisions/0006-codex-project-hooks.md.
//   node scripts/codex-hooks.js [--project <dir>] [--check]
// Default project: the git root of the current folder. Exit 1 on --check drift,
// bad usage, or an existing hooks.json that cannot be parsed (never overwritten).
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PLUGIN_HOOKS = path.join(ROOT, 'hooks', 'hooks.json');
const SHIM_TEMPLATE = path.join(ROOT, 'templates', 'project', '.codex', 'agent-team-hook.js');
const SHIM_NAME = 'agent-team-hook.js';

// One command string per script, the same for every project and machine (no
// absolute paths), so the Codex trust hash stays stable across regeneration.
// Hooks run from the session cwd, which may be a subfolder, so the command finds
// the git root itself. Only double quotes on the outside and single quotes on
// the inside, so it parses the same in sh and cmd.exe. If the shim cannot be
// found, warn on stderr and exit 0 (fail open).
function shimCommand(script) {
  const js =
    "try{require(require('path').join(require('child_process').execFileSync('git',['rev-parse','--show-toplevel'],{stdio:['ignore','pipe','ignore']}).toString().trim(),'.codex','" + SHIM_NAME + "'))}" +
    "catch(e){console.error('agent-team hook shim not found; guard and logging off; GitHub rulesets still apply')}";
  return `node -e "${js}" ${script}`;
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const isOurs = (h) => isObj(h) && typeof h.command === 'string' && h.command.includes(SHIM_NAME);

// Script name from a plugin hook command like node "${CLAUDE_PLUGIN_ROOT}/scripts/guard.js".
function scriptOf(command) {
  const m = /\/scripts\/([\w-]+)\.js["']?\s*$/.exec(command || '');
  return m ? m[1] : null;
}

// The Codex hooks derived from the plugin's hooks.json: same events, matchers
// and timeouts, each command replaced by the shim call for its script.
function generate(pluginHooks) {
  const out = {};
  const events = isObj(pluginHooks) && isObj(pluginHooks.hooks) ? pluginHooks.hooks : {};
  for (const [event, groups] of Object.entries(events)) {
    const made = [];
    for (const group of Array.isArray(groups) ? groups : []) {
      const hooks = [];
      for (const h of Array.isArray(group.hooks) ? group.hooks : []) {
        const script = scriptOf(h.command);
        if (!script) continue; // not one of our scripts: nothing to point the shim at
        const e = { type: 'command', command: shimCommand(script) };
        if (h.timeout !== undefined) e.timeout = h.timeout;
        hooks.push(e);
      }
      if (!hooks.length) continue;
      made.push({ ...(group.matcher !== undefined ? { matcher: group.matcher } : {}), hooks });
    }
    if (made.length) out[event] = made;
  }
  return out;
}

// Merge generated groups into an existing hooks object. Our shim entries are
// replaced (in the position of the first one found, else appended); everything
// else is kept. Idempotent: merging the result again changes nothing.
function merge(existing, generated) {
  const result = {};
  const events = new Set([...Object.keys(existing), ...Object.keys(generated)]);
  for (const event of events) {
    const old = Array.isArray(existing[event]) ? existing[event] : [];
    const kept = [];
    let at = -1;
    for (const group of old) {
      const hooks = isObj(group) && Array.isArray(group.hooks) ? group.hooks : null;
      if (!hooks || !hooks.some(isOurs)) { kept.push(group); continue; }
      const rest = hooks.filter((h) => !isOurs(h));
      if (rest.length) kept.push({ ...group, hooks: rest });
      if (at < 0) at = kept.length; // a group shared with user hooks keeps its place; ours follows it
    }
    const add = generated[event] || [];
    if (at < 0) at = kept.length;
    kept.splice(at, 0, ...add);
    if (kept.length) result[event] = kept;
  }
  return result;
}

function gitRoot(cwd) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return cwd;
  }
}

const readText = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };

// Plan the two files for a project: [{ file, text, current }].
// Throws Error with a user-facing message when hooks.json is unusable.
function plan(project) {
  const codexDir = path.join(project, '.codex');
  const shimFile = path.join(codexDir, SHIM_NAME);
  const hooksFile = path.join(codexDir, 'hooks.json');
  const shim = fs.readFileSync(SHIM_TEMPLATE, 'utf8');

  const generated = generate(JSON.parse(fs.readFileSync(PLUGIN_HOOKS, 'utf8')));
  const currentText = readText(hooksFile);
  let doc = {};
  if (currentText !== null) {
    try { doc = JSON.parse(currentText); } catch (err) {
      throw new Error(`${hooksFile} is not valid JSON (${err.message}); fix or remove it, then run again. Nothing was changed.`);
    }
    if (!isObj(doc) || (doc.hooks !== undefined && !isObj(doc.hooks))) {
      throw new Error(`${hooksFile} does not have the expected shape ({"hooks": {...}}); fix or remove it, then run again. Nothing was changed.`);
    }
  }
  const merged = { ...doc, hooks: merge(isObj(doc.hooks) ? doc.hooks : {}, generated) };
  // Compare as data so a user's own formatting is left alone when nothing changed.
  const same = currentText !== null && doc.hooks !== undefined && JSON.stringify(doc.hooks) === JSON.stringify(merged.hooks);
  return [
    { file: shimFile, text: shim, current: readText(shimFile) },
    { file: hooksFile, text: same ? currentText : JSON.stringify(merged, null, 2) + '\n', current: currentText },
  ];
}

function main(argv) {
  let project = null;
  let check = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) { console.error('--project requires a value'); return 1; }
      project = path.resolve(v);
    } else if (a === '--check') check = true;
    else { console.error('usage: codex-hooks.js [--project <dir>] [--check]'); return 1; }
  }
  if (!project) project = gitRoot(process.cwd());
  let files;
  try { files = plan(project); } catch (err) { console.error(err.message); return 1; }
  const stale = files.filter((f) => f.current !== f.text);
  if (check) {
    for (const f of stale) console.log(`${f.current === null ? 'missing' : 'out of date'}: ${f.file}`);
    if (stale.length) { console.log('Run: node scripts/codex-hooks.js' + ' (then trust the hooks in Codex: /hooks)'); return 1; }
    console.log('ok: Codex project hooks are up to date');
    return 0;
  }
  for (const f of stale) {
    fs.mkdirSync(path.dirname(f.file), { recursive: true });
    fs.writeFileSync(f.file, f.text, 'utf8');
    console.log(`${f.current === null ? 'wrote' : 'updated'}: ${f.file}`);
  }
  if (!stale.length) console.log('Codex project hooks already up to date.');
  else console.log('Codex runs project hooks only after you trust them once per project: open /hooks (or accept the startup prompt). Untrusted hooks do nothing, silently.');
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { shimCommand, generate, merge, plan, main, SHIM_NAME };
