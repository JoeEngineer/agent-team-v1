// Tests for scripts/session-start.js and the guard's .agent-team/worktrees check.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const { ROOT, bareProject: tmpProject, run, test, assert, eq } = require('./helpers');
const lib = require('../scripts/lib');

console.log('session-start');

const version = lib.guidanceVersion();
const marker = (dir) => path.join(dir, '.agent-team', 'logs', '.pending', 'hooks-alive.json');
const claudeIn = { session_id: 's1', hook_event_name: 'SessionStart', source: 'startup' };
const codexIn = { session_id: 's2', turn_id: 't1', hook_event_name: 'SessionStart', model: 'gpt-x', transcript_path: '/t/s2.jsonl' };

test('output shape, Claude input, marker written when .agent-team exists', () => {
  const dir = tmpProject();
  fs.mkdirSync(path.join(dir, '.agent-team'));
  const r = run('session-start.js', claudeIn, dir);
  eq(r.status, 0, 'exit');
  assert(version !== 'unknown', 'version read from manifest');
  eq(r.stdout, JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: `agent-team hooks: active (claude, ${version})` } }), 'output');
  const m = JSON.parse(fs.readFileSync(marker(dir), 'utf8'));
  eq(m.tool, 'claude', 'marker tool');
  eq(m.guidance_version, version, 'marker version');
  eq(m.session_id, 's1', 'marker session');
  assert(!Number.isNaN(Date.parse(m.ts)), 'marker ts');
});

test('Codex input reports codex', () => {
  const dir = tmpProject();
  fs.mkdirSync(path.join(dir, '.agent-team'));
  const r = run('session-start.js', codexIn, dir);
  eq(r.status, 0, 'exit');
  eq(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, `agent-team hooks: active (codex, ${version})`, 'context');
  eq(JSON.parse(fs.readFileSync(marker(dir), 'utf8')).tool, 'codex', 'marker tool');
});

test('project not set up for agent-team: silent, and no folders created', () => {
  const dir = tmpProject();
  for (const input of [claudeIn, codexIn, { ...claudeIn, source: 'compact' }]) {
    const r = run('session-start.js', input, dir);
    eq(r.status, 0, 'exit');
    eq(r.stdout, '', 'nothing printed');
  }
  assert(!fs.existsSync(path.join(dir, '.agent-team')), '.agent-team not created');
});

test('set up by the project settings, by its Codex hooks, or run from the project hooks: line printed', () => {
  const viaSettings = tmpProject();
  fs.mkdirSync(path.join(viaSettings, '.claude'));
  fs.writeFileSync(path.join(viaSettings, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'agent-team@agent-team': true } }));
  assert(run('session-start.js', claudeIn, viaSettings).stdout.includes('agent-team hooks: active'), 'settings.json');
  assert(!fs.existsSync(path.join(viaSettings, '.agent-team')), '.agent-team not created');
  const viaCodex = tmpProject();
  fs.mkdirSync(path.join(viaCodex, '.codex'));
  fs.writeFileSync(path.join(viaCodex, '.codex', 'hooks.json'), '{"hooks":{"x":"node .codex/agent-team-hook.js guard"}}');
  assert(run('session-start.js', codexIn, viaCodex).stdout.includes('agent-team hooks: active'), 'codex hooks.json');
  const viaShim = tmpProject();
  assert(run('session-start.js', codexIn, viaShim, { AGENT_TEAM_HOOK_SOURCE: 'project' }).stdout.includes('agent-team hooks: active'), 'project hook source');
});

test('a git worktree of a set-up checkout counts as set up, even when .agent-team/ is ignored', () => {
  const gitIn = (cwd) => (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd });
  const force = (cwd) => run('guard.js', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push --force' }, cwd }, cwd);
  const main = tmpProject();
  const git = gitIn(main);
  fs.writeFileSync(path.join(main, '.gitignore'), '.agent-team/\nwt/\n');
  git('add', '.gitignore');
  git('commit', '-q', '-m', 'init');
  fs.mkdirSync(path.join(main, '.agent-team'));
  const wt = path.join(main, 'wt', 'a');
  git('worktree', 'add', '-q', '-b', 'task/T-2', wt);
  assert(!fs.existsSync(path.join(wt, '.agent-team')), 'the worktree has no .agent-team of its own');
  assert(run('session-start.js', claudeIn, wt).stdout.includes('agent-team hooks: active'), 'line printed in the worktree');
  assert(force(wt).stdout.includes('"permissionDecision":"deny"'), 'guard acts in the worktree');
  // The marker and the logs go to the main checkout, not into the worktree.
  eq(JSON.parse(fs.readFileSync(marker(main), 'utf8')).session_id, 's1', 'marker in the main checkout');
  assert(!fs.existsSync(path.join(wt, '.agent-team')), 'session start leaves no .agent-team in the worktree');
  const logged = spawnSync('node', [path.join(ROOT, 'scripts', 'log-event.js'), 'note', '{"text":"from a worktree"}'], { encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: wt } });
  eq(logged.status, 0, logged.stderr);
  assert(fs.readFileSync(path.join(main, '.agent-team', 'logs', 'notes.jsonl'), 'utf8').includes('from a worktree'), 'note in the main checkout');
  assert(!fs.existsSync(path.join(wt, '.agent-team')), 'logging leaves no .agent-team in the worktree');
  // Codex has no CLAUDE_PROJECT_DIR: the project is the git root of the cwd.
  const env = { ...process.env };
  delete env.CLAUDE_PROJECT_DIR;
  const codexNote = spawnSync('node', [path.join(ROOT, 'scripts', 'log-event.js'), 'note', '{"text":"codex cwd"}'], { cwd: wt, encoding: 'utf8', env });
  eq(codexNote.status, 0, codexNote.stderr);
  assert(fs.readFileSync(path.join(main, '.agent-team', 'logs', 'notes.jsonl'), 'utf8').includes('codex cwd'), 'cwd in a worktree: note in the main checkout');
  // A worktree that has its own (tracked) .agent-team folder still logs to the main checkout.
  fs.mkdirSync(path.join(wt, '.agent-team', 'logs'), { recursive: true });
  spawnSync('node', [path.join(ROOT, 'scripts', 'log-event.js'), 'note', '{"text":"own folder"}'], { encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: wt } });
  assert(fs.readFileSync(path.join(main, '.agent-team', 'logs', 'notes.jsonl'), 'utf8').includes('own folder'), 'still the main checkout');
  eq(fs.readdirSync(path.join(wt, '.agent-team', 'logs')).length, 0, 'nothing written in the worktree');
  eq(lib.mainCheckout(main), null, 'the main checkout has no other main checkout');
  // A worktree of a checkout that is not set up stays off.
  const bare = tmpProject();
  const git2 = gitIn(bare);
  git2('commit', '-q', '--allow-empty', '-m', 'init');
  const wt2 = path.join(bare, 'wt2');
  git2('worktree', 'add', '-q', '-b', 'task/T-3', wt2);
  eq(run('session-start.js', claudeIn, wt2).stdout, '', 'silent');
  eq(force(wt2).stdout, '', 'guard off');
});

test('garbage and empty stdin: exit 0, still prints output where set up, silent where not', () => {
  const dir = tmpProject();
  const bare = tmpProject();
  fs.mkdirSync(path.join(dir, '.agent-team'));
  for (const input of ['{not json', '']) {
    const at = (d) => spawnSync('node', [path.join(ROOT, 'scripts', 'session-start.js')], { input, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: d } });
    const r = at(dir);
    eq(r.status, 0, 'exit');
    assert(r.stdout.includes('"additionalContext"'), 'context printed');
    const b = at(bare);
    eq(b.status, 0, 'exit, not set up');
    eq(b.stdout, '', 'silent, not set up');
  }
  assert(!fs.existsSync(path.join(bare, '.agent-team')), 'nothing created');
});

test('unwritable marker location does not fail the hook', () => {
  const dir = tmpProject();
  // .agent-team/logs is a file, so creating logs/.pending fails.
  fs.mkdirSync(path.join(dir, '.agent-team'));
  fs.writeFileSync(path.join(dir, '.agent-team', 'logs'), 'x');
  const r = run('session-start.js', claudeIn, dir);
  eq(r.status, 0, 'exit');
  assert(r.stdout.includes('"additionalContext"'), 'context printed');
});

test('guard: git add -A / . blocked while .agent-team/worktrees/ exists unignored', () => {
  const dir = tmpProject();
  const g = (command) => run('guard.js', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: dir }, dir);
  const denied = (r) => r.stdout.includes('"permissionDecision":"deny"');
  assert(!denied(g('git add -A')), 'allowed with no worktrees folder');
  fs.mkdirSync(path.join(dir, '.agent-team', 'worktrees', 'task-x'), { recursive: true });
  for (const cmd of ['git add -A', 'git add .', 'git add --all']) {
    const r = g(cmd);
    assert(denied(r), `"${cmd}" blocked`);
    assert(r.stdout.includes('.agent-team/worktrees/'), 'names the folder');
  }
  assert(!denied(g('git add STATUS.md docs/')), 'explicit paths allowed');
  fs.writeFileSync(path.join(dir, '.gitignore'), '.agent-team/worktrees/\n');
  assert(!denied(g('git add -A')), 'allowed once ignored');
  fs.mkdirSync(path.join(dir, '.claude', 'worktrees', 'a'), { recursive: true });
  assert(denied(g('git add -A')), 'still blocked by unignored .claude/worktrees');
});

test('after a compaction the Director is told to re-read STATUS.md and the references; not on startup, and not where agent-team is unused', () => {
  const dir = tmpProject();
  fs.mkdirSync(path.join(dir, '.agent-team'));
  const compact = { ...claudeIn, source: 'compact' };
  const ctx = (r) => JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  const after = ctx(run('session-start.js', compact, dir));
  assert(after.startsWith(`agent-team hooks: active (claude, ${version})`), 'the hooks line still comes first');
  assert(/context was compacted/.test(after) && /re-read STATUS\.md/.test(after) && /merging\.md before any merge/.test(after), after);
  eq(ctx(run('session-start.js', claudeIn, dir)), `agent-team hooks: active (claude, ${version})`, 'startup: no note');
  eq(ctx(run('session-start.js', { ...claudeIn, source: 'resume' }, dir)), `agent-team hooks: active (claude, ${version})`, 'resume: no note');
  const unused = tmpProject();
  eq(run('session-start.js', compact, unused).stdout, '', 'no .agent-team: nothing at all');
});
