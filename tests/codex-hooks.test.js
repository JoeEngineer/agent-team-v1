// Codex project hooks: scripts/codex-hooks.js writes .codex/hooks.json and the
// shim; the shim finds the plugin and runs its hook scripts. The commands are run
// the way Codex runs them (through a shell, from the session cwd).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ROOT, SCRIPTS, tmpProject, readLog, test, assert, eq } = require('./helpers');
const codexHooks = require(path.join(SCRIPTS, 'codex-hooks.js'));

const CODEX_HOOKS = path.join(SCRIPTS, 'codex-hooks.js');
const WARNING = 'agent-team plugin not found; guard and logging off; GitHub rulesets still apply';

const tmp = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `agent-team-ch-${label}-`));
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

// Environment for a hook run: nothing from the real Codex/Claude setup leaks in.
function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^AGENT_TEAM_/.test(k) || ['CODEX_HOME', 'CLAUDE_PROJECT_DIR', 'CLAUDE_PLUGIN_ROOT'].includes(k)) delete env[k];
  }
  return { ...env, ...extra };
}

function generate(project, args = []) {
  return spawnSync('node', [CODEX_HOOKS, '--project', project, ...args], { encoding: 'utf8', env: cleanEnv() });
}

const hooksFile = (project) => path.join(project, '.codex', 'hooks.json');
const allCommands = (doc) => Object.values(doc.hooks).flatMap((groups) => groups.flatMap((g) => g.hooks.map((h) => h.command)));

// A command from a generated hooks.json: event, nth group.
const commandFor = (project, event, group = 0) => readJson(hooksFile(project)).hooks[event][group].hooks[0].command;

// Run a command string through the platform shell (cmd.exe on Windows, sh elsewhere).
function runCmd(cmd, { cwd, input = '', env = {}, shell = true } = {}) {
  return spawnSync(cmd, { shell, cwd, input, encoding: 'utf8', env: cleanEnv(env) });
}

// A stand-in plugin: each hook script reports how it was called as JSON on stdout.
function fakePlugin(dir, label, { exit = 0 } = {}) {
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  const body = (name) =>
    "const fs = require('fs');\n" +
    'const stdin = fs.readFileSync(0, "utf8");\n' +
    `process.stdout.write(JSON.stringify({ label: ${JSON.stringify(label)}, script: ${JSON.stringify(name)}, source: process.env.AGENT_TEAM_HOOK_SOURCE, ` +
    'project: process.env.CLAUDE_PROJECT_DIR, pluginRoot: process.env.CLAUDE_PLUGIN_ROOT, tool: process.env.AGENT_TEAM_TOOL, stdin }));\n' +
    (exit ? `process.stderr.write("script said no\\n"); process.exit(${exit});\n` : '');
  for (const n of ['guard', 'log-delegation', 'session-start']) fs.writeFileSync(path.join(dir, 'scripts', `${n}.js`), body(n));
}

// <home>/plugins/cache/<market>/agent-team/<version>/ with a fake plugin inside.
function cachePlugin(home, market, version) {
  const dir = path.join(home, 'plugins', 'cache', market, 'agent-team', version);
  fakePlugin(dir, `${market}/${version}`);
  return dir;
}

function samePath(a, b, msg) {
  const norm = (p) => path.resolve(p).replace(/\\/g, '/').toLowerCase();
  try {
    eq(norm(fs.realpathSync(a)), norm(fs.realpathSync(b)), msg);
  } catch (err) {
    if (err.code) eq(norm(a), norm(b), msg); else throw err;
  }
}

// --- generated files -----------------------------------------------------------

test('codex-hooks: writes the shim and a hooks.json with the same events and matchers as the plugin', () => {
  const p = tmpProject();
  const r = generate(p);
  eq(r.status, 0, r.stderr);
  const shim = path.join(p, '.codex', 'agent-team-hook.js');
  eq(fs.readFileSync(shim, 'utf8'), fs.readFileSync(path.join(ROOT, 'templates', 'project', '.codex', 'agent-team-hook.js'), 'utf8'), 'shim is the template');
  const plugin = readJson(path.join(ROOT, 'hooks', 'hooks.json')).hooks;
  const doc = readJson(hooksFile(p));
  eq(JSON.stringify(Object.keys(doc.hooks)), JSON.stringify(Object.keys(plugin)), 'same events');
  let groups = 0;
  for (const [event, list] of Object.entries(plugin)) {
    eq(doc.hooks[event].length, list.length, `${event}: group count`);
    list.forEach((g, i) => {
      groups++;
      eq(doc.hooks[event][i].matcher, g.matcher, `${event}[${i}] matcher`);
      eq(doc.hooks[event][i].hooks[0].timeout, g.hooks[0].timeout, `${event}[${i}] timeout`);
    });
  }
  assert(groups >= 5, 'precondition: several groups compared');
});

test('codex-hooks: commands are plain, one string per script, no absolute paths or plugin variables', () => {
  const a = tmpProject(), b = tmpProject();
  generate(a);
  generate(b);
  const cmds = allCommands(readJson(hooksFile(a)));
  const distinct = [...new Set(cmds)];
  eq(distinct.length, 3, 'one command string per script (guard, log-delegation, session-start)');
  for (const c of cmds) {
    assert(!/\$\{|CLAUDE_PLUGIN_ROOT|PLUGIN_ROOT/.test(c), `no plugin variable in ${c}`);
    assert(!c.includes(os.tmpdir()) && !/[A-Za-z]:[\\/]/.test(c) && !c.includes(a), `no absolute path in ${c}`);
    assert(!c.includes('\\'), `no backslashes (cmd.exe and sh read them differently) in ${c}`);
  }
  eq(JSON.stringify(allCommands(readJson(hooksFile(b)))), JSON.stringify(cmds), 'identical for every project');
});

test('codex-hooks: regeneration leaves the file and every command string byte-identical (trust hash stable)', () => {
  const p = tmpProject();
  generate(p);
  const first = fs.readFileSync(hooksFile(p), 'utf8');
  const shim1 = fs.readFileSync(path.join(p, '.codex', 'agent-team-hook.js'), 'utf8');
  const r = generate(p);
  eq(r.status, 0, r.stderr);
  assert(/up to date/.test(r.stdout), `second run reports nothing to do: ${r.stdout}`);
  eq(fs.readFileSync(hooksFile(p), 'utf8'), first, 'hooks.json bytes');
  eq(fs.readFileSync(path.join(p, '.codex', 'agent-team-hook.js'), 'utf8'), shim1, 'shim bytes');
  // a third pass, after the shim is deleted, still gives the same hooks.json
  fs.rmSync(path.join(p, '.codex', 'agent-team-hook.js'));
  generate(p);
  eq(fs.readFileSync(hooksFile(p), 'utf8'), first, 'hooks.json bytes after restoring the shim');
  eq(fs.readFileSync(path.join(p, '.codex', 'agent-team-hook.js'), 'utf8'), shim1, 'shim restored');
});

// --- merge and --check -----------------------------------------------------------

test('codex-hooks: merges into an existing hooks.json without dropping user entries, idempotently', () => {
  const p = tmpProject();
  fs.mkdirSync(path.join(p, '.codex'));
  const mine = { type: 'command', command: 'echo mine', timeout: 5 };
  const user = {
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [mine] }],
      Stop: [{ hooks: [{ type: 'command', command: 'echo stop' }] }],
    },
    custom: { keep: true },
  };
  fs.writeFileSync(hooksFile(p), JSON.stringify(user, null, 2));
  eq(generate(p).status, 0, 'first run');
  const doc = readJson(hooksFile(p));
  eq(doc.custom.keep, true, 'unknown top-level key kept');
  eq(JSON.stringify(doc.hooks.Stop), JSON.stringify(user.hooks.Stop), 'unrelated event untouched');
  eq(JSON.stringify(doc.hooks.PreToolUse[0]), JSON.stringify(user.hooks.PreToolUse[0]), 'user group kept, first');
  const shimCmds = allCommands({ hooks: { PreToolUse: doc.hooks.PreToolUse } }).filter((c) => c.includes('agent-team-hook.js'));
  eq(shimCmds.length, 2, 'guard and log-delegation added to PreToolUse');
  assert(doc.hooks.SessionStart && doc.hooks.SubagentStop && doc.hooks.PostToolUse, 'other plugin events added');
  const first = fs.readFileSync(hooksFile(p), 'utf8');
  generate(p);
  eq(fs.readFileSync(hooksFile(p), 'utf8'), first, 'second run changes nothing');
  // a stale agent-team entry (old command text) is replaced, not duplicated, and user hooks sharing its group survive
  const stale = readJson(hooksFile(p));
  stale.hooks.SessionStart[0].hooks.unshift({ type: 'command', command: 'echo before' });
  stale.hooks.SessionStart[0].hooks[1].command = 'node ".codex/agent-team-hook.js" old';
  fs.writeFileSync(hooksFile(p), JSON.stringify(stale, null, 2));
  generate(p);
  const fixed = readJson(hooksFile(p));
  eq(fixed.hooks.SessionStart.length, 2, 'user group and the regenerated group');
  eq(fixed.hooks.SessionStart[0].hooks[0].command, 'echo before', 'user hook kept');
  eq(allCommands({ hooks: { SessionStart: fixed.hooks.SessionStart } }).filter((c) => c.includes('agent-team-hook.js')).length, 1, 'one shim entry');
  assert(!JSON.stringify(fixed).includes(' old'), 'stale command gone');
});

test('codex-hooks: an existing hooks.json that is already correct is not rewritten, even if formatted differently', () => {
  const p = tmpProject();
  generate(p);
  const compact = JSON.stringify(readJson(hooksFile(p)));
  fs.writeFileSync(hooksFile(p), compact);
  eq(generate(p, ['--check']).status, 0, 'check passes on a compact file');
  generate(p);
  eq(fs.readFileSync(hooksFile(p), 'utf8'), compact, 'bytes untouched');
});

test('codex-hooks: --check reports missing and drifted files with exit 1, and passes when current', () => {
  const p = tmpProject();
  const missing = generate(p, ['--check']);
  eq(missing.status, 1, 'nothing written yet');
  assert(/missing/.test(missing.stdout), `names the missing file: ${missing.stdout}`);
  assert(!fs.existsSync(path.join(p, '.codex')), '--check writes nothing');
  generate(p);
  eq(generate(p, ['--check']).status, 0, 'current');
  fs.appendFileSync(path.join(p, '.codex', 'agent-team-hook.js'), '// edited\n');
  const drift = generate(p, ['--check']);
  eq(drift.status, 1, 'shim drift');
  assert(/agent-team-hook\.js/.test(drift.stdout), 'names the shim');
  generate(p);
  const doc = readJson(hooksFile(p));
  delete doc.hooks.SubagentStop;
  fs.writeFileSync(hooksFile(p), JSON.stringify(doc));
  eq(generate(p, ['--check']).status, 1, 'hooks.json drift (an event removed)');
});

test('codex-hooks: a malformed hooks.json is refused: exit 1, message, file untouched', () => {
  const p = tmpProject();
  fs.mkdirSync(path.join(p, '.codex'));
  fs.writeFileSync(hooksFile(p), '{ "hooks": { oops');
  for (const args of [[], ['--check']]) {
    const r = generate(p, args);
    eq(r.status, 1, `exit ${args.join(' ')}`);
    assert(/not valid JSON/.test(r.stderr), `message: ${r.stderr}`);
  }
  eq(fs.readFileSync(hooksFile(p), 'utf8'), '{ "hooks": { oops', 'file untouched');
  assert(!fs.existsSync(path.join(p, '.codex', 'agent-team-hook.js')), 'no shim written either');
  // a valid JSON file of the wrong shape is refused too
  fs.writeFileSync(hooksFile(p), '[1,2]');
  eq(generate(p).status, 1, 'array refused');
  fs.writeFileSync(hooksFile(p), '{"hooks": []}');
  eq(generate(p).status, 1, 'hooks as an array refused');
});

test('codex-hooks: bad usage exits 1', () => {
  eq(spawnSync('node', [CODEX_HOOKS, '--nope'], { encoding: 'utf8' }).status, 1, 'unknown flag');
  eq(spawnSync('node', [CODEX_HOOKS, '--project'], { encoding: 'utf8' }).status, 1, 'missing value');
});

test('codex-hooks: merge() with no existing hooks and generate() skip commands that are not agent-team scripts', () => {
  const g = codexHooks.generate({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo hi' }] }], PreToolUse: [{ matcher: 'X', hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/guard.js"', timeout: 3 }] }] } });
  eq(Object.keys(g).join(','), 'PreToolUse', 'only the agent-team event');
  eq(g.PreToolUse[0].matcher, 'X', 'matcher');
  eq(g.PreToolUse[0].hooks[0].timeout, 3, 'timeout');
  eq(JSON.stringify(codexHooks.merge({}, {})), '{}', 'empty merge');
});

// --- the shim, run through a shell ---------------------------------------------------

test('shim: runs through a shell from the project root and from a subfolder, with project env and stdin passed through', () => {
  const p = tmpProject();
  generate(p);
  const plugin = tmp('plugin');
  fakePlugin(plugin, 'forced');
  const sub = path.join(p, 'src', 'deeper');
  fs.mkdirSync(sub, { recursive: true });
  for (const cwd of [p, sub]) {
    const r = runCmd(commandFor(p, 'PreToolUse', 0), { cwd, input: '{"hello":"world"}', env: { AGENT_TEAM_PLUGIN_ROOT: plugin } });
    eq(r.status, 0, `exit from ${cwd}: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    eq(out.script, 'guard', 'guard command runs guard');
    eq(out.source, 'project', 'AGENT_TEAM_HOOK_SOURCE');
    samePath(out.project, p, 'CLAUDE_PROJECT_DIR is the git root');
    samePath(out.pluginRoot, plugin, 'CLAUDE_PLUGIN_ROOT is the plugin');
    eq(out.tool, 'codex', 'tool forced to codex');
    eq(out.stdin, '{"hello":"world"}', 'stdin passed through');
  }
  // the other scripts map to their own file
  eq(JSON.parse(runCmd(commandFor(p, 'PreToolUse', 1), { cwd: sub, env: { AGENT_TEAM_PLUGIN_ROOT: plugin } }).stdout).script, 'log-delegation', 'log-delegation');
  eq(JSON.parse(runCmd(commandFor(p, 'SessionStart', 0), { cwd: sub, env: { AGENT_TEAM_PLUGIN_ROOT: plugin } }).stdout).script, 'session-start', 'session-start');
});

test('shim: lookup order is AGENT_TEAM_PLUGIN_ROOT, then the Codex cache under CODEX_HOME', () => {
  const p = tmpProject();
  generate(p);
  const home = tmp('home');
  cachePlugin(home, 'market', '1.0.0');
  const forced = tmp('forced');
  fakePlugin(forced, 'forced');
  const cmd = commandFor(p, 'PreToolUse', 0);
  const viaEnv = JSON.parse(runCmd(cmd, { cwd: p, env: { CODEX_HOME: home, AGENT_TEAM_PLUGIN_ROOT: forced } }).stdout);
  eq(viaEnv.label, 'forced', 'env var wins over the cache');
  const viaCache = JSON.parse(runCmd(cmd, { cwd: p, env: { CODEX_HOME: home } }).stdout);
  eq(viaCache.label, 'market/1.0.0', 'cache used without the env var');
  // one step past: an env var that points nowhere falls through to the cache
  const bad = JSON.parse(runCmd(cmd, { cwd: p, env: { CODEX_HOME: home, AGENT_TEAM_PLUGIN_ROOT: path.join(home, 'nope') } }).stdout);
  eq(bad.label, 'market/1.0.0', 'invalid env var falls back to the cache');
});

test('shim: with CODEX_HOME unset the cache is ~/.codex (HOME / USERPROFILE)', () => {
  const p = tmpProject();
  generate(p);
  const fakeHome = tmp('userhome');
  cachePlugin(path.join(fakeHome, '.codex'), 'market', '2.0.0');
  const r = runCmd(commandFor(p, 'PreToolUse', 0), { cwd: p, env: { HOME: fakeHome, USERPROFILE: fakeHome } });
  eq(r.status, 0, r.stderr);
  eq(JSON.parse(r.stdout).label, 'market/2.0.0', 'found under <home>/.codex');
});

test('shim: with two versions in the cache the highest wins, by semver not lexically', () => {
  const p = tmpProject();
  generate(p);
  const home = tmp('home');
  for (const [m, v] of [['m1', '0.9.0'], ['m1', '0.10.0'], ['m2', '0.2.0'], ['m1', '0.10.0-rc1'], ['m1', 'not-a-version']]) cachePlugin(home, m, v);
  // lexical order would pick 0.9.0; the folder name with no digits must lose to every real version
  const out = JSON.parse(runCmd(commandFor(p, 'PreToolUse', 0), { cwd: p, env: { CODEX_HOME: home } }).stdout);
  eq(out.label, 'm1/0.10.0', 'highest semver; a release beats its own prerelease');
  // a higher version in another marketplace wins too
  cachePlugin(home, 'm2', '1.0.0');
  eq(JSON.parse(runCmd(commandFor(p, 'PreToolUse', 0), { cwd: p, env: { CODEX_HOME: home } }).stdout).label, 'm2/1.0.0', 'across marketplaces');
});

test('shim: a cache folder without scripts/log-delegation.js is not a plugin', () => {
  const p = tmpProject();
  generate(p);
  const home = tmp('home');
  cachePlugin(home, 'm', '1.0.0');
  fs.mkdirSync(path.join(home, 'plugins', 'cache', 'm', 'agent-team', '9.9.9', 'scripts'), { recursive: true }); // empty "newer" version
  eq(JSON.parse(runCmd(commandFor(p, 'PreToolUse', 0), { cwd: p, env: { CODEX_HOME: home } }).stdout).label, 'm/1.0.0', 'incomplete 9.9.9 skipped');
});

test('shim: plugin missing gives one stderr warning, exit 0, nothing on stdout', () => {
  const p = tmpProject();
  generate(p);
  const home = tmp('empty-home');
  for (const env of [{ CODEX_HOME: home }, { CODEX_HOME: path.join(home, 'does-not-exist') }]) {
    const r = runCmd(commandFor(p, 'PreToolUse', 0), { cwd: p, env });
    eq(r.status, 0, 'fails open');
    eq(r.stdout, '', 'stdout stays empty');
    eq(r.stderr.trim(), WARNING, 'exactly the warning');
  }
});

test('shim: outside a git folder it warns and exits 0 without throwing', () => {
  const p = tmpProject();
  generate(p);
  const cmd = commandFor(p, 'PreToolUse', 0);
  const parent = tmp('nogit');
  const plain = path.join(parent, 'plain');
  fs.mkdirSync(plain);
  const r = runCmd(cmd, { cwd: plain, env: { GIT_CEILING_DIRECTORIES: parent, AGENT_TEAM_PLUGIN_ROOT: ROOT } });
  eq(r.status, 0, `exit: ${r.stderr}`);
  eq(r.stdout, '', 'stdout stays empty');
  assert(r.stderr.includes('agent-team') && !/at .*\.js:\d+/.test(r.stderr), `a short warning, no stack trace: ${r.stderr}`);
  assert(!/fatal: not a git/.test(r.stderr), 'git error not leaked');
});

test('shim: relays the script exit code and stderr, and stdout is only the script stdout', () => {
  const p = tmpProject();
  generate(p);
  const plugin = tmp('failing');
  fakePlugin(plugin, 'failing', { exit: 2 });
  const r = runCmd(commandFor(p, 'PreToolUse', 0), { cwd: p, env: { AGENT_TEAM_PLUGIN_ROOT: plugin } });
  eq(r.status, 2, 'exit code relayed');
  assert(r.stderr.includes('script said no'), 'stderr relayed');
  eq(JSON.parse(r.stdout).label, 'failing', 'stdout is the script output only');
});

test('shim: a guard deny still blocks through the shim, from a subfolder', () => {
  const p = tmpProject(); // on branch task/T-1
  generate(p);
  const sub = path.join(p, 'a', 'b');
  fs.mkdirSync(sub, { recursive: true });
  const input = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push origin main' }, cwd: sub });
  const r = runCmd(commandFor(p, 'PreToolUse', 0), { cwd: sub, input, env: { AGENT_TEAM_PLUGIN_ROOT: ROOT } });
  eq(r.status, 0, `exit: ${r.stderr}`);
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  eq(out.permissionDecision, 'deny', 'deny JSON relayed');
  // one step past: a harmless command is allowed (no stdout)
  const ok = runCmd(commandFor(p, 'PreToolUse', 0), { cwd: sub, env: { AGENT_TEAM_PLUGIN_ROOT: ROOT }, input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: sub }) });
  eq(ok.status, 0, 'allowed exit');
  eq(ok.stdout, '', 'allowed: no stdout');
});

test('shim: the logger through the shim writes to the project root, from a subfolder', () => {
  const p = tmpProject();
  generate(p);
  const sub = path.join(p, 'x');
  fs.mkdirSync(sub);
  const input = JSON.stringify({
    hook_event_name: 'PostToolUse', tool_name: 'collaborationspawn_agent', session_id: 's', turn_id: 't', cwd: sub,
    tool_input: { agent_type: 'implementer-medium', task_name: 'sh_1_a1', reasoning_effort: 'high', message: 'x' }, tool_response: '', tool_use_id: 'c1',
  });
  const r = runCmd(commandFor(p, 'PostToolUse', 0), { cwd: sub, input, env: { AGENT_TEAM_PLUGIN_ROOT: ROOT } });
  eq(r.status, 0, r.stderr);
  const d = readLog(p, 'delegations.jsonl');
  eq(d.length, 1, 'one delegation in the project root');
  eq(d[0].task_name, 'sh_1_a1', 'task_name');
  assert(!fs.existsSync(path.join(sub, '.agent-team')), 'nothing in the subfolder');
});

test('shim: works with spaces in the project path and the plugin cache path', () => {
  const base = tmp('spaces');
  const p = path.join(base, 'my project');
  fs.mkdirSync(p);
  require('child_process').execFileSync('git', ['init', '-q', '-b', 'task/T-1'], { cwd: p });
  generate(p);
  const home = path.join(base, 'codex home');
  const dir = cachePlugin(home, 'my market', '1.2.3');
  assert(dir.includes(' '), 'precondition: the plugin path has a space');
  const sub = path.join(p, 'a dir');
  fs.mkdirSync(sub);
  const r = runCmd(commandFor(p, 'PreToolUse', 0), { cwd: sub, input: '{}', env: { CODEX_HOME: home } });
  eq(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  eq(out.label, 'my market/1.2.3', 'plugin found');
  samePath(out.project, p, 'project root with a space');
});

// --- other shells --------------------------------------------------------------------

function shellAvailable(file, args) {
  const r = spawnSync(file, args, { encoding: 'utf8' });
  return !r.error && r.status === 0;
}

const SHELLS = [
  ['bash', 'bash', ['-c'], ['--version']],
  ['powershell', process.platform === 'win32' ? 'powershell' : 'pwsh', ['-NoProfile', '-NonInteractive', '-Command'], ['-NoProfile', '-Command', 'exit 0']],
];

for (const [label, file, pre, probe] of SHELLS) {
  if (!shellAvailable(file, probe)) { console.log(`  skip shim in ${label}: not available here`); continue; }
  test(`shim: the same command string works in ${label}, from a subfolder`, () => {
    const p = tmpProject();
    generate(p);
    const plugin = tmp('plugin');
    fakePlugin(plugin, 'forced');
    const sub = path.join(p, 'sub');
    fs.mkdirSync(sub);
    const r = spawnSync(file, [...pre, commandFor(p, 'PreToolUse', 0)], {
      cwd: sub, input: '{"k":1}', encoding: 'utf8', env: cleanEnv({ AGENT_TEAM_PLUGIN_ROOT: plugin }),
    });
    eq(r.status, 0, `exit: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    eq(out.script, 'guard', 'script');
    eq(out.stdin, '{"k":1}', 'stdin');
    samePath(out.project, p, 'project root');
  });
}
