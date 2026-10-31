'use strict';

const fs = require('fs');
const path = require('path');
const { test, assert, eq, run, tmpProject, readLog, ROOT } = require('./helpers');
const lib = require('../scripts/lib');

console.log('tools');

const NOENV = {};
const det = (input, env = NOENV) => lib.detectTool(input, env);

test('detectTool: env override both ways', () => {
  eq(det({ tool_name: 'Agent' }, { AGENT_TEAM_TOOL: 'codex' }), 'codex', 'forced codex');
  eq(det({ tool_name: 'spawn_agent', turn_id: 't' }, { AGENT_TEAM_TOOL: 'claude' }), 'claude', 'forced claude');
  eq(det({ tool_name: 'send_input' }, { AGENT_TEAM_TOOL: 'bogus' }), 'codex', 'invalid value ignored');
});

test('detectTool: Codex-only tool names', () => {
  for (const t of ['collaborationspawn_agent', 'spawn_agent', 'send_input', 'apply_patch', 'wait_agent', 'close_agent', 'resume_agent', 'list_agents']) {
    eq(det({ tool_name: t }), 'codex', t);
  }
});

test('detectTool: turn_id marks Codex even for Bash', () => {
  eq(det({ tool_name: 'Bash', turn_id: 'abc' }), 'codex', 'Bash+turn_id');
  eq(det({ tool_name: 'Bash' }), 'claude', 'Bash alone');
});

test('detectTool: Claude-shaped inputs and garbage', () => {
  for (const t of ['Agent', 'Task', 'Bash', 'SendMessage', 'mcp__ccd_session__start_session']) {
    eq(det({ tool_name: t, model: 'x' }), 'claude', t);
  }
  eq(det({ tool_name: 'mcp__codex-bridge__spawn_agent' }), 'claude', 'mcp spawn_agent');
  eq(det({ tool_name: 'mcp__x__send_input' }), 'claude', 'mcp send_input');
  eq(det({ tool_name: 'spawn_agent' }), 'codex', 'bare spawn_agent');
  eq(det({ tool_name: 'collaborationspawn_agent' }), 'codex', 'collaborationspawn_agent');
  eq(det({}), 'claude', 'empty');
  eq(det(null), 'claude', 'null');
  eq(det('str'), 'claude', 'string');
});

const MSG = 'gAAAAABencryptedpayload';
const spawnTi = { task_name: 'worker1', agent_type: 'worker', reasoning_effort: 'medium', fork_turns: 'none', message: MSG };
const common = { session_id: 's1', turn_id: 'turn1', model: 'gpt-x', transcript_path: '/t/s1.jsonl' };
const codexPre = { ...common, hook_event_name: 'PreToolUse', tool_name: 'collaborationspawn_agent', tool_input: spawnTi };
const codexPost = { ...codexPre, hook_event_name: 'PostToolUse', tool_response: { task_name: '/root/worker1' } };
const codexStop = {
  ...common, hook_event_name: 'SubagentStop', agent_id: 'ag1', agent_type: 'worker',
  agent_transcript_path: '/t/ag1.jsonl', last_assistant_message: 'done',
};

test('codex events are logged to codex-events.jsonl only, without message', () => {
  const dir = tmpProject();
  for (const ev of [codexPre, codexPost, codexStop]) {
    const r = run('log-delegation.js', ev, dir);
    eq(r.status, 0, 'exit');
  }
  const rows = readLog(dir, 'codex-events.jsonl');
  eq(rows.length, 3, 'row count');
  eq(rows[0].tool, 'codex', 'tool');
  eq(rows[0].hook_event_name, 'PreToolUse', 'event');
  eq(rows[0].task_name, 'worker1', 'task_name');
  eq(rows[0].reasoning_effort, 'medium', 'effort');
  eq(rows[0].turn_id, 'turn1', 'turn_id');
  eq(rows[1].tool_response.task_name, '/root/worker1', 'response');
  eq(rows[2].agent_id, 'ag1', 'agent_id');
  eq(rows[2].agent_transcript_path, '/t/ag1.jsonl', 'agent transcript');
  eq(rows[2].last_assistant_message, 'done', 'last message');
  const raw = fs.readFileSync(path.join(dir, '.agent-team', 'logs', 'codex-events.jsonl'), 'utf8');
  assert(!raw.includes('"message"') && !raw.includes('gAAAA'), 'message must not be logged');
  eq(readLog(dir, 'delegations.jsonl').length, 0, 'delegations.jsonl untouched');
});

test('codex Bash PostToolUse writes nothing', () => {
  const dir = tmpProject();
  const r = run('log-delegation.js', { ...common, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: 'x' }, dir);
  eq(r.status, 0, 'exit');
  eq(readLog(dir, 'codex-events.jsonl').length, 0, 'codex log empty');
  eq(readLog(dir, 'delegations.jsonl').length, 0, 'delegations empty');
  eq(readLog(dir, 'merges.jsonl').length, 0, 'merges empty');
});

test('long last_assistant_message is truncated to 2000 chars; big tool_response truncated', () => {
  const dir = tmpProject();
  run('log-delegation.js', { ...codexStop, last_assistant_message: 'a'.repeat(5000) }, dir);
  run('log-delegation.js', { ...codexPost, tool_response: { x: 'b'.repeat(5000) } }, dir);
  const rows = readLog(dir, 'codex-events.jsonl');
  eq(rows[0].last_assistant_message.length, 2000, 'truncated');
  eq(typeof rows[1].tool_response.truncated, 'string', 'truncated object');
  assert(rows[1].tool_response.truncated.endsWith('...[truncated]'), 'truncation marker');
  assert(rows[1].tool_response.truncated.length < 700, 'response truncated');
});

test('codex event with missing fields still logs with nulls', () => {
  const dir = tmpProject();
  run('log-delegation.js', { hook_event_name: 'SubagentStop', turn_id: 't' }, dir);
  const rows = readLog(dir, 'codex-events.jsonl');
  eq(rows.length, 1, 'rows');
  eq(rows[0].agent_id, null, 'agent_id null');
});

test('claude records include tool:"claude"', () => {
  const dir = tmpProject();
  const r = run('log-delegation.js', {
    hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: 'u1', session_id: 's',
    tool_input: { description: 'd', prompt: 'p', subagent_type: 'x' }, tool_response: { content: [{ type: 'text', text: 'ok' }] },
  }, dir);
  eq(r.status, 0, 'exit');
  const rows = readLog(dir, 'delegations.jsonl');
  assert(rows.length >= 1, 'a delegation was logged');
  eq(rows[0].tool, 'claude', 'tool');
  eq(readLog(dir, 'codex-events.jsonl').length, 0, 'no codex log');
});

test('garbage stdin exits 0', () => {
  const dir = tmpProject();
  const { spawnSync } = require('child_process');
  const r = spawnSync('node', [path.join(ROOT, 'scripts', 'log-delegation.js')], { input: '{not json', encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });
  eq(r.status, 0, 'exit');
});

const hooks = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8'));
const GUARD_MATCHER = 'Bash|PowerShell';
const LOGGER_PRE_MATCHER = 'Agent|Task|mcp__ccd_session__start_session|mcp__codex-bridge__.*|mcp__antigravity-bridge__.*|^(?:collaboration)?spawn_agent$|^(?:send_input|resume_agent|wait_agent|close_agent)$';
const LOGGER_POST_MATCHER = 'Agent|Task|SendMessage|Bash|PowerShell|mcp__ccd_session__start_session|mcp__ccd_session_mgmt__set_session_model|mcp__ccd_session_mgmt__set_session_effort|mcp__codex-bridge__.*|mcp__antigravity-bridge__.*|^(?:collaboration)?spawn_agent$|^(?:send_input|resume_agent|wait_agent|close_agent)$';
const GUARD_CMD = 'node "${CLAUDE_PLUGIN_ROOT}/scripts/guard.js"';
const LOGGER_CMD = 'node "${CLAUDE_PLUGIN_ROOT}/scripts/log-delegation.js"';

test('hooks.json: matchers pinned exactly and compile', () => {
  const [guard, logPre] = hooks.hooks.PreToolUse;
  const logPost = hooks.hooks.PostToolUse[0];
  eq(guard.matcher, GUARD_MATCHER, 'guard matcher');
  eq(logPre.matcher, LOGGER_PRE_MATCHER, 'logger pre matcher');
  eq(logPost.matcher, LOGGER_POST_MATCHER, 'logger post matcher');
  for (const e of Object.values(hooks.hooks).flat()) if (e.matcher) new RegExp(e.matcher);
});

test('hooks.json: logger matches Codex tools and Claude-side tools still match', () => {
  const m = (matcher, t) => new RegExp(`^(?:${matcher})$`).test(t);
  for (const matcher of [LOGGER_PRE_MATCHER, LOGGER_POST_MATCHER]) {
    for (const t of ['collaborationspawn_agent', 'spawn_agent', 'send_input', 'resume_agent', 'wait_agent', 'close_agent', 'Agent']) {
      assert(m(matcher, t), `logger matches ${t}`);
    }
    // Anchored Codex alternatives must not match MCP tools whose names contain those strings.
    // Precondition: the old unanchored Codex alternatives did match these names as substrings,
    // so the negative assertions below test something real.
    const OLD_CODEX = /.*spawn_agent|send_input|resume_agent|wait_agent|close_agent/;
    for (const t of ['mcp__x__send_input', 'mcp__x__spawn_agent', 'mcp__x__collaborationspawn_agent', 'mcp__x__wait_agent']) {
      assert(OLD_CODEX.test(t), `precondition: old alternatives matched ${t}`);
      assert(!m(matcher, t), `logger does not match ${t}`);
    }
    // Boundary: the anchors reject a name that merely starts or ends with a tool name.
    for (const t of ['send_input_extra', 'xspawn_agent', 'spawn_agent2']) {
      assert(OLD_CODEX.test(t), `precondition: old alternatives matched ${t}`);
      assert(!m(matcher, t), `logger does not match ${t}`);
    }
  }
  for (const t of ['Bash', 'PowerShell']) assert(m(GUARD_MATCHER, t), `guard matches ${t}`);
  for (const t of ['Agent', 'Task', 'SendMessage', 'Bash', 'PowerShell', 'mcp__ccd_session__start_session',
    'mcp__ccd_session_mgmt__set_session_model', 'mcp__ccd_session_mgmt__set_session_effort',
    'mcp__codex-bridge__codex_run', 'mcp__antigravity-bridge__antigravity_run']) {
    assert(m(LOGGER_POST_MATCHER, t), `post matcher matches ${t}`);
  }
});

test('hooks.json: commands pinned exactly (no git dependency)', () => {
  const [guard, logPre] = hooks.hooks.PreToolUse;
  eq(guard.hooks[0].command, GUARD_CMD, 'guard command');
  eq(logPre.hooks[0].command, LOGGER_CMD, 'logger pre command');
  eq(hooks.hooks.PostToolUse[0].hooks[0].command, LOGGER_CMD, 'logger post command');
  eq(hooks.hooks.SubagentStop[0].hooks[0].command, LOGGER_CMD, 'subagent stop command');
  eq(hooks.hooks.SubagentStop[0].matcher, undefined, 'subagent stop has no matcher');
});

