// Tests for scripts/session-start.js and the guard's .agent-team/worktrees check.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { ROOT, tmpProject, run, test, assert, eq } = require('./helpers');
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

test('no folders created when .agent-team is missing; output still printed', () => {
  const dir = tmpProject();
  const r = run('session-start.js', claudeIn, dir);
  eq(r.status, 0, 'exit');
  assert(r.stdout.includes('agent-team hooks: active'), 'context printed');
  assert(!fs.existsSync(path.join(dir, '.agent-team')), '.agent-team not created');
});

test('garbage and empty stdin: exit 0, still prints output', () => {
  const dir = tmpProject();
  for (const input of ['{not json', '']) {
    const r = spawnSync('node', [path.join(ROOT, 'scripts', 'session-start.js')], { input, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });
    eq(r.status, 0, 'exit');
    assert(r.stdout.includes('"additionalContext"'), 'context printed');
  }
  assert(!fs.existsSync(path.join(dir, '.agent-team')), 'nothing created');
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
