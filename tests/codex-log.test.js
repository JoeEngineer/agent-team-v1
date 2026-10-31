// Codex logging: raw codex-events.jsonl plus normalized records in the shared
// log files. Fixtures are trimmed, synthetic copies of live-captured shapes
// (Codex CLI 0.166), with no task text.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { ROOT, SCRIPTS, NO_MODELS_FILE, tmpProject, run, fakeGh, readLog, test, assert, eq } = require('./helpers');
const lib = require(path.join(SCRIPTS, 'lib.js'));

const SID = 'sess-1';
const AID = 'agent-1';

function hook(project, input, env) {
  const r = run('log-delegation.js', { session_id: SID, turn_id: 'turn-1', cwd: project, model: 'gpt-test', permission_mode: 'bypassPermissions', ...input }, project, env);
  eq(r.status, 0, 'hook exit');
  return r;
}

const spawn = (over = {}) => ({
  hook_event_name: 'PostToolUse',
  tool_name: 'collaborationspawn_agent',
  tool_input: { agent_type: 'implementer-medium', task_name: 'cd_7_a1', reasoning_effort: 'high', message: 'gAAAAAencrypted', fork_turns: 'all' },
  tool_response: '{"task_name":"/root/cd_7_a1"}',
  tool_use_id: 'call_1',
  ...over,
});

function transcript(dir, { turns = 1, name = 'cd_7_a1', withTokens = true } = {}) {
  const ev = (type, payload) => JSON.stringify({ timestamp: 't', type, payload });
  const lines = [
    ev('session_meta', { id: AID, agent_path: `/root/${name}`, source: { subagent: { thread_spawn: { agent_path: `/root/${name}` } } } }),
    ev('session_meta', { id: SID, source: 'exec' }),
    ev('turn_context', { turn_id: 'inherited', model: 'parent-model', effort: 'low' }),
  ];
  let cum = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 };
  for (let i = 1; i <= turns; i++) {
    lines.push(ev('event_msg', { type: 'task_started', turn_id: `turn-${i}` }));
    lines.push(ev('turn_context', { turn_id: `turn-${i}`, model: 'gpt-6.1-terra', effort: 'high' }));
    if (withTokens) {
      cum = {
        input_tokens: cum.input_tokens + 1000 * i, cached_input_tokens: cum.cached_input_tokens + 400 * i,
        output_tokens: cum.output_tokens + 50 * i, reasoning_output_tokens: cum.reasoning_output_tokens + 10 * i,
        total_tokens: cum.total_tokens + 1050 * i,
      };
      lines.push(ev('event_msg', { type: 'token_count', info: { total_token_usage: cum, last_token_usage: {} } }));
    }
    lines.push(ev('event_msg', { type: 'task_complete', turn_id: `turn-${i}`, duration_ms: 1000 * i }));
  }
  const file = path.join(dir, `agent-${turns}-${withTokens}.jsonl`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

const stop = (project, file, over = {}) => ({
  hook_event_name: 'SubagentStop',
  agent_id: AID,
  agent_type: 'implementer-medium',
  agent_transcript_path: file,
  stop_hook_active: false,
  last_assistant_message: 'done\n```result-json\n{"status":"done"}\n```',
  ...over,
});

const directorLine = (project, env = {}) =>
  spawnSync('node', [path.join(SCRIPTS, 'log-event.js'), 'delegation', JSON.stringify({
    card: 'TASK id=CD-7 type=implement attempt=1 tier=medium\nWHY routing table', tool: 'codex',
    task_name: 'cd_7_a1', agent: 'implementer-medium', model: 'gpt-6.1-terra', tier: 'medium', effort: 'medium',
  })], { cwd: project, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: project, CLAUDE_PLUGIN_ROOT: ROOT, ...env } });

// --- raw log -----------------------------------------------------------------

test('codex: raw events still logged for both prefixed and bare tool names, never the message', () => {
  const p = tmpProject();
  for (const name of ['collaborationfollowup_task', 'collaborationwait_agent', 'followup_task', 'wait_agent']) {
    hook(p, { hook_event_name: 'PostToolUse', tool_name: name, tool_input: { target: 'x', message: 'SECRET' }, tool_response: '' });
  }
  const raw = readLog(p, 'codex-events.jsonl');
  eq(raw.length, 4, 'raw lines');
  assert(!JSON.stringify(raw).includes('SECRET'), 'message must not be logged');
});

test('codex: detectTool knows bare followup_task', () => {
  eq(lib.detectTool({ tool_name: 'followup_task' }, {}), 'codex', 'followup_task');
  eq(lib.detectTool({ tool_name: 'collaborationfollowup_task' }, {}), 'codex', 'prefixed');
});

// --- spawn fallback ----------------------------------------------------------

test('codex: spawn writes a hook fallback delegation, tier from the agent name', () => {
  const p = tmpProject();
  hook(p, spawn());
  const d = readLog(p, 'delegations.jsonl');
  eq(d.length, 1, 'one delegation');
  eq(d[0].tool, 'codex', 'tool');
  eq(d[0].kind, 'subagent', 'kind');
  eq(d[0].source, 'hook', 'source');
  eq(d[0].task_name, 'cd_7_a1', 'task_name');
  eq(d[0].agent, 'implementer-medium', 'agent');
  eq(d[0].effort, 'high', 'effort');
  eq(d[0].tier, 'medium', 'tier');
  eq(d[0].model_source, 'agent-name', 'model source');
  assert(d[0].model && d[0].model !== 'inherited', 'model from the map');
  assert(!JSON.stringify(d).includes('gAAAA'), 'message not logged');
});

test('codex: spawn reads model and effort from .codex/agents/<type>.toml when present', () => {
  const p = tmpProject();
  fs.mkdirSync(path.join(p, '.codex', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(p, '.codex', 'agents', 'implementer-medium.toml'), 'name = "implementer-medium"\nmodel = "custom-model"\nmodel_reasoning_effort = "low"\n');
  const input = spawn();
  delete input.tool_input.reasoning_effort;
  hook(p, input);
  const d = readLog(p, 'delegations.jsonl')[0];
  eq(d.model, 'custom-model', 'model');
  eq(d.model_source, 'agent-file', 'source');
  eq(d.effort, 'low', 'effort from toml');
  eq(d.tier, 'medium', 'tier falls back to the name suffix');
});

test('codex: spawn with no agent_type or unknown type still logs, tier null', () => {
  const p = tmpProject();
  const input = spawn();
  delete input.tool_input.agent_type;
  hook(p, input);
  const d = readLog(p, 'delegations.jsonl')[0];
  eq(d.agent, null, 'agent');
  eq(d.tier, null, 'tier');
  eq(d.model, 'inherited', 'model');
});

test('codex: spawn is skipped when a delegation with that task_name exists (Director first)', () => {
  const p = tmpProject();
  const r = directorLine(p);
  eq(r.status, 0, `log-event exit: ${r.stderr}`);
  hook(p, spawn());
  const d = readLog(p, 'delegations.jsonl');
  eq(d.length, 1, 'no fallback line');
  eq(d[0].source, 'director', 'director line kept');
  // one step past: a second spawn event for the same name still adds nothing
  hook(p, spawn({ tool_use_id: 'call_2' }));
  eq(readLog(p, 'delegations.jsonl').length, 1, 'still one');
});

test('codex: Director line after the hook fallback gives two lines (Coach dedupes)', () => {
  const p = tmpProject();
  hook(p, spawn());
  directorLine(p);
  const d = readLog(p, 'delegations.jsonl');
  eq(d.length, 2, 'both lines');
  eq(d.map((x) => x.source).join(','), 'hook,director', 'order');
});

// --- completion --------------------------------------------------------------

test('codex: SubagentStop writes a completion with tokens, model, effort, duration, linked to the Director card', () => {
  const p = tmpProject();
  directorLine(p);
  const file = transcript(p);
  hook(p, stop(p, file, { turn_id: 'turn-1' }));
  const c = readLog(p, 'completions.jsonl');
  eq(c.length, 1, 'one completion');
  eq(c[0].tool, 'codex', 'tool');
  eq(c[0].task_name, 'cd_7_a1', 'task_name from agent_path');
  eq(c[0].resolved_model, 'gpt-6.1-terra', 'last turn_context model');
  eq(c[0].resolved_effort, 'high', 'last turn_context effort');
  eq(c[0].tokens, 1050, 'tokens');
  eq(c[0].tokens_detail.input, 1000, 'input');
  eq(c[0].tokens_detail.cached_input, 400, 'cached');
  eq(c[0].tokens_detail.output, 50, 'output');
  eq(c[0].tokens_detail.reasoning_output, 10, 'reasoning');
  eq(c[0].duration_ms, 1000, 'duration');
  eq(c[0].report_source, 'hook-input', 'report source');
  eq(c[0].result.status, 'done', 'result');
  eq(c[0].task.id, 'CD-7', 'linked task');
  eq(c[0].task.attempt, 1, 'attempt');
  eq(c[0].tier, 'medium', 'tier from delegation');
});

const delegationLine = (project, data) => {
  const r = logEvent(project, 'delegation', { tool: 'codex', task_name: 'cd_7_a1', agent: 'implementer-medium', ...data });
  eq(r.status, 0, r.stderr);
};

test('codex: with both a hook line and a Director line, the completion links to the Director card and keeps its routing fields', () => {
  const p = tmpProject();
  hook(p, spawn());
  delegationLine(p, { card: 'TASK id=CD-7 type=implement attempt=2 tier=large', model: 'director-model', effort: 'low', tier: 'large', tier_source: 'card' });
  const d = readLog(p, 'delegations.jsonl');
  eq(d.map((x) => x.source).join(','), 'hook,director', 'precondition: both lines present');
  hook(p, stop(p, transcript(p), { turn_id: 'turn-1' }));
  const c = readLog(p, 'completions.jsonl')[0];
  eq(c.task.id, 'CD-7', 'linked to the Director card, not the hook line (empty task)');
  eq(c.task.attempt, 2, 'attempt from the card');
  eq(c.model, 'director-model', 'Director model, not the hook line model');
  eq(c.effort, 'low', 'Director effort, not the hook line effort (high)');
  eq(c.tier, 'large', 'Director tier, not the hook line tier (medium)');
  eq(c.tier_source, 'card', 'Director tier source');
});

test('codex: a Director line without model/effort/tier is filled from the hook fallback line', () => {
  const p = tmpProject();
  hook(p, spawn());
  delegationLine(p, { card: 'TASK id=CD-7 type=implement attempt=1' });
  const d = readLog(p, 'delegations.jsonl');
  eq(d[1].source, 'director', 'precondition: the Director line is the latest');
  assert(d[1].model === undefined && d[1].effort === undefined && d[1].tier === undefined, 'precondition: Director line has no routing fields');
  hook(p, stop(p, transcript(p), { turn_id: 'turn-1' }));
  const c = readLog(p, 'completions.jsonl')[0];
  eq(c.task.id, 'CD-7', 'still the Director card');
  eq(c.model, d[0].model, 'model from the hook line');
  eq(c.effort, 'high', 'effort from the hook line');
  eq(c.tier, 'medium', 'tier from the hook line');
  eq(c.tier_source, 'agent-name', 'tier source from the hook line');
});

test('codex: with no hook line, tier comes from the task card before the resolved model', () => {
  const p = tmpProject();
  delegationLine(p, { card: 'TASK id=CD-7 type=implement attempt=1 tier=small' });
  eq(readLog(p, 'delegations.jsonl').length, 1, 'precondition: only the Director line');
  hook(p, stop(p, transcript(p), { turn_id: 'turn-1' }));
  const c = readLog(p, 'completions.jsonl')[0];
  eq(c.resolved_model, 'gpt-6.1-terra', 'the resolved model would give medium');
  eq(c.tier, 'small', 'task.tier wins over the tier of the resolved model');
  eq(c.tier_source, 'task-card', 'source');
});

test('codex: with no hook line and no task.tier, the tier is derived from the resolved model', () => {
  const p = tmpProject();
  delegationLine(p, { card: 'TASK id=CD-7 type=implement attempt=1' });
  hook(p, stop(p, transcript(p), { turn_id: 'turn-1' }));
  const c = readLog(p, 'completions.jsonl')[0];
  eq(c.tier, 'medium', 'tier of gpt-6.1-terra');
  eq(c.tier_source, 'resolved', 'source');
});

test('codex: SubagentStop is deduped; a second report for the same agent is a new line', () => {
  const p = tmpProject();
  const file = transcript(p);
  hook(p, stop(p, file, { turn_id: 'turn-1' }));
  hook(p, stop(p, file, { turn_id: 'turn-1' }));
  eq(readLog(p, 'completions.jsonl').length, 1, 'duplicate dropped');
  hook(p, stop(p, file, { turn_id: 'turn-1', last_assistant_message: 'again' }));
  eq(readLog(p, 'completions.jsonl').length, 2, 'new report logged');
});

test('codex: resumed agent counts only the latest turn tokens', () => {
  const p = tmpProject();
  const file = transcript(p, { turns: 2 });
  hook(p, stop(p, file, { turn_id: 'turn-2' }));
  const c = readLog(p, 'completions.jsonl')[0];
  eq(c.tokens, 2100, 'turn 2 only (cumulative 3150 minus 1050)');
  eq(c.tokens_detail.input, 2000, 'input delta');
  eq(c.duration_ms, 2000, 'last task_complete duration');
  eq(c.resolved_model, 'gpt-6.1-terra', 'last turn_context');
});

test('codex: no token_count events gives null tokens', () => {
  const p = tmpProject();
  const file = transcript(p, { withTokens: false });
  hook(p, stop(p, file, { turn_id: 'turn-1' }));
  const c = readLog(p, 'completions.jsonl')[0];
  eq(c.tokens, null, 'tokens');
  eq(c.tokens_detail, null, 'detail');
  eq(c.resolved_model, 'gpt-6.1-terra', 'model still read');
});

test('codex: missing transcript logs the completion from last_assistant_message only', () => {
  const p = tmpProject();
  hook(p, stop(p, path.join(p, 'nope.jsonl')));
  const c = readLog(p, 'completions.jsonl');
  eq(c.length, 1, 'completion');
  eq(c[0].task_name, null, 'task_name');
  eq(c[0].resolved_model, null, 'model');
  eq(c[0].tokens, null, 'tokens');
  eq(c[0].duration_ms, null, 'duration');
  eq(c[0].result.status, 'done', 'result from message');
  // absent transcript path and empty message are also fine
  hook(p, stop(p, undefined, { agent_id: 'a2', agent_transcript_path: undefined, last_assistant_message: '' }));
  eq(readLog(p, 'completions.jsonl').length, 2, 'second completion');
});

test('codex: a review block in the final message writes one reviews.jsonl line with tool codex', () => {
  const p = tmpProject();
  const file = transcript(p);
  const msg = 'ok\n```review-json\n{"verdict":"approve","findings":[]}\n```';
  hook(p, stop(p, file, { turn_id: 'turn-1', last_assistant_message: msg }));
  hook(p, stop(p, file, { turn_id: 'turn-1', last_assistant_message: msg }));
  const r = readLog(p, 'reviews.jsonl');
  eq(r.length, 1, 'one review (deduped)');
  eq(r[0].tool, 'codex', 'tool');
  eq(r[0].verdict, 'approve', 'verdict');
  eq(r[0].agent_id, AID, 'agent id');
  eq(readLog(p, 'completions.jsonl')[0].review.verdict, 'approve', 'completion carries review');
});

// --- follow-up ---------------------------------------------------------------

test('codex: follow-up to a known task_name writes one resume fallback, never the message', () => {
  const p = tmpProject();
  hook(p, spawn());
  const fu = { hook_event_name: 'PostToolUse', tool_name: 'collaborationfollowup_task', tool_input: { target: 'cd_7_a1', message: 'SECRET' }, tool_response: '', tool_use_id: 'call_f' };
  hook(p, fu);
  hook(p, fu);
  const d = readLog(p, 'delegations.jsonl');
  eq(d.length, 2, 'spawn + one resume');
  eq(d[1].kind, 'resume', 'kind');
  eq(d[1].source, 'hook', 'source');
  eq(d[1].task_name, 'cd_7_a1', 'task_name');
  eq(d[1].tool, 'codex', 'tool');
  assert(!JSON.stringify(d).includes('SECRET'), 'message not logged');
});

test('codex: follow-up to an unknown target writes no delegation line', () => {
  const p = tmpProject();
  hook(p, { hook_event_name: 'PostToolUse', tool_name: 'collaborationfollowup_task', tool_input: { target: 'ghost' }, tool_response: '', tool_use_id: 'call_g' });
  eq(readLog(p, 'delegations.jsonl').length, 0, 'nothing');
  eq(readLog(p, 'codex-events.jsonl').length, 1, 'raw still logged');
});

// --- merges ------------------------------------------------------------------

test('codex: Bash gh pr merge writes a merge line with tool codex', () => {
  const p = tmpProject();
  hook(p, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'gh pr merge 5 --squash' }, tool_response: 'ok', tool_use_id: 'exec-1' },
    fakeGh(JSON.stringify({ number: 5, state: 'MERGED', autoMergeRequest: null })));
  const m = readLog(p, 'merges.jsonl');
  eq(m.length, 1, 'one merge');
  eq(m[0].tool, 'codex', 'tool');
  eq(m[0].outcome, 'merged', 'outcome');
  hook(p, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: '', tool_use_id: 'exec-2' });
  eq(readLog(p, 'merges.jsonl').length, 1, 'other commands add nothing');
});

// --- project dir -------------------------------------------------------------

test('codex: with CLAUDE_PROJECT_DIR unset, a hook run from a subfolder logs at the git root', () => {
  const p = tmpProject();
  const sub = path.join(p, 'sub', 'deeper');
  fs.mkdirSync(sub, { recursive: true });
  const r = run('log-delegation.js', { ...spawn(), session_id: SID, turn_id: 't', cwd: sub }, '');
  eq(r.status, 0, 'exit');
  const real = fs.realpathSync(p);
  assert(fs.existsSync(path.join(real, '.agent-team', 'logs', 'delegations.jsonl')), 'log at root');
  assert(!fs.existsSync(path.join(sub, '.agent-team')), 'nothing in the subfolder');
});

// Run fn with CLAUDE_PROJECT_DIR unset and, if given, GIT_CEILING_DIRECTORIES set.
function withEnv(set, fn) {
  const saved = {};
  for (const k of Object.keys(set)) {
    saved[k] = process.env[k];
    if (set[k] === undefined) delete process.env[k]; else process.env[k] = set[k];
  }
  try { return fn(); } finally {
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

test('codex: projectDir falls back to cwd outside git, honours CLAUDE_PROJECT_DIR', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-team-nogit-'));
  const plain = path.join(parent, 'plain');
  fs.mkdirSync(plain);
  // Git must not look above the parent: the precondition below fails loudly if
  // the folder is still inside a repo (it never skips the assertion).
  withEnv({ CLAUDE_PROJECT_DIR: undefined, GIT_CEILING_DIRECTORIES: parent }, () => {
    let inRepo = true;
    try { execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: plain, stdio: 'ignore' }); } catch { inRepo = false; }
    assert(!inRepo, `precondition: ${plain} must not be inside a git repo`);
    eq(lib.projectDir({ cwd: plain }), plain, 'fallback to cwd');
    process.env.CLAUDE_PROJECT_DIR = 'X:/forced';
    eq(lib.projectDir({ cwd: plain }), 'X:/forced', 'env wins');
  });
});

test('codex: projectDir remembers the git lookup per cwd within a process', () => {
  const p = tmpProject();
  const sub = path.join(p, 'a', 'b');
  fs.mkdirSync(sub, { recursive: true });
  withEnv({ CLAUDE_PROJECT_DIR: undefined, GIT_CEILING_DIRECTORIES: path.dirname(p) }, () => {
    const root = lib.projectDir({ cwd: sub });
    assert(root.endsWith(path.basename(p)), `first call finds the git root, got ${root}`);
    // Remove the repo: a fresh lookup would now fall back to the subfolder.
    fs.rmSync(path.join(p, '.git'), { recursive: true, force: true });
    eq(lib.projectDir({ cwd: sub }), root, 'second call is served from memory (no new git spawn)');
    // A different cwd is looked up separately.
    eq(lib.projectDir({ cwd: p }), p, 'other cwd is its own entry (no repo any more)');
  });
});

test('codex: a plugin-hook event is ignored when the project hooks file runs the shim; the shim itself still logs', () => {
  const p = tmpProject();
  fs.mkdirSync(path.join(p, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(p, '.codex', 'hooks.json'), JSON.stringify({ hooks: { SubagentStop: [{ hooks: [{ type: 'command', command: 'node -e "..." log-delegation # agent-team-hook.js' }] }] } }));
  // plugin hook: AGENT_TEAM_HOOK_SOURCE unset
  hook(p, spawn(), { AGENT_TEAM_HOOK_SOURCE: '' });
  eq(readLog(p, 'delegations.jsonl').length, 0, 'plugin copy skipped: no delegation');
  eq(readLog(p, 'codex-events.jsonl').length, 0, 'plugin copy skipped: no raw event');
  // one step past: the same event through the project hook is logged
  hook(p, spawn(), { AGENT_TEAM_HOOK_SOURCE: 'project' });
  eq(readLog(p, 'delegations.jsonl').length, 1, 'project hook logs');
  eq(readLog(p, 'codex-events.jsonl').length, 1, 'project hook logs raw event');
});

test('codex: a plugin-hook event is logged when the project hooks file does not mention the shim', () => {
  const p = tmpProject();
  fs.mkdirSync(path.join(p, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(p, '.codex', 'hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo user hook' }] }] } }));
  hook(p, spawn(), { AGENT_TEAM_HOOK_SOURCE: '' });
  eq(readLog(p, 'delegations.jsonl').length, 1, 'logged');
  // and with no hooks file at all
  const q = tmpProject();
  hook(q, spawn(), { AGENT_TEAM_HOOK_SOURCE: '' });
  eq(readLog(q, 'delegations.jsonl').length, 1, 'logged without a hooks file');
});

// --- log-event.js -------------------------------------------------------------

function logEvent(project, kind, data, env = {}) {
  return spawnSync('node', [path.join(SCRIPTS, 'log-event.js'), kind, JSON.stringify(data)], {
    cwd: project, encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: project, CLAUDE_PLUGIN_ROOT: ROOT, AGENT_TEAM_MODELS: NO_MODELS_FILE, ...env },
  });
}

test('log-event: delegation parses the card, WHY, tool and source', () => {
  const p = tmpProject();
  const r = logEvent(p, 'delegation', { card: 'TASK id=X-1 type=implement attempt=2 tier=small\nWHY cheap and clear', task_name: 'x_1_a2', agent: 'implementer-small' }, { AGENT_TEAM_TOOL: 'codex' });
  eq(r.status, 0, r.stderr);
  const d = readLog(p, 'delegations.jsonl');
  eq(d.length, 1, 'one line');
  eq(d[0].tool, 'codex', 'tool from env');
  eq(d[0].source, 'director', 'source');
  eq(d[0].task.id, 'X-1', 'task id');
  eq(d[0].task.attempt, 2, 'attempt number');
  eq(d[0].task.why, 'cheap and clear', 'why');
  eq(d[0].task_name, 'x_1_a2', 'task_name');
  assert(d[0].card === undefined, 'raw card not stored');
});

test('log-event: tool defaults to unknown, why field works, explicit tool wins, no card is fine', () => {
  const p = tmpProject();
  logEvent(p, 'delegation', { card: 'TASK id=X-1', why: 'because' }, { AGENT_TEAM_TOOL: '' });
  logEvent(p, 'delegation', { tool: 'claude', task_name: 'n' });
  const d = readLog(p, 'delegations.jsonl');
  eq(d[0].tool, 'unknown', 'default');
  eq(d[0].task.why, 'because', 'why field');
  eq(d[1].tool, 'claude', 'explicit');
  eq(JSON.stringify(d[1].task), '{}', 'empty task');
});

test('log-event: review goes to reviews.jsonl in the logReview shape', () => {
  const p = tmpProject();
  const r = logEvent(p, 'review', { card: 'TASK id=X-2 type=review reviewed_task=X-1 pr=9 attempt=1', verdict: 'approve', agent_id: 'r1', tool: 'codex', model: 'gpt-6.1-sol' });
  eq(r.status, 0, r.stderr);
  const v = readLog(p, 'reviews.jsonl');
  eq(v.length, 1, 'one review');
  eq(v[0].task_id, 'X-1', 'reviewed task');
  eq(v[0].pr, '9', 'pr');
  eq(v[0].attempt, 1, 'attempt');
  eq(v[0].reviewer_model, 'gpt-6.1-sol', 'reviewer model');
  eq(v[0].verdict, 'approve', 'verdict');
  eq(v[0].tool, 'codex', 'tool');
  eq(v[0].source, 'director', 'source');
});

test('log-event: existing kinds unchanged and bad input rejected', () => {
  const p = tmpProject();
  eq(logEvent(p, 'note', { text: 'hi' }).status, 0, 'note ok');
  const n = readLog(p, 'notes.jsonl');
  eq(n[0].text, 'hi', 'note body');
  assert(n[0].source === undefined && n[0].tool === undefined, 'no extra fields');
  eq(logEvent(p, 'bogus', {}).status, 1, 'unknown kind');
  const bad = spawnSync('node', [path.join(SCRIPTS, 'log-event.js'), 'note', '{nope'], { cwd: p, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: p } });
  eq(bad.status, 1, 'bad JSON');
});

// log-event.js input forms: argv (above), stdin ("-") and --file.

function logEventWith(project, args, input) {
  return spawnSync('node', [path.join(SCRIPTS, 'log-event.js'), ...args], {
    cwd: project, encoding: 'utf8', input,
    env: { ...process.env, CLAUDE_PROJECT_DIR: project, CLAUDE_PLUGIN_ROOT: ROOT, AGENT_TEAM_MODELS: NO_MODELS_FILE },
  });
}

test('log-event stdin: delegation JSON on stdin is parsed like the argv form', () => {
  const p = tmpProject();
  const r = logEventWith(p, ['delegation', '-'], JSON.stringify({ card: 'TASK id=X-1 type=implement attempt=1 tier=small\nWHY stdin', task_name: 'x_1_a1', agent: 'implementer-small', tool: 'codex' }));
  eq(r.status, 0, r.stderr);
  eq(r.stdout.trim(), 'logged delegation to .agent-team/logs/delegations.jsonl', 'message');
  const d = readLog(p, 'delegations.jsonl');
  eq(d.length, 1, 'one line');
  eq(d[0].tool, 'codex', 'tool');
  eq(d[0].source, 'director', 'source');
  eq(d[0].task.id, 'X-1', 'task id');
  eq(d[0].task.why, 'stdin', 'why');
  eq(d[0].task_name, 'x_1_a1', 'task_name');
});

test('log-event stdin: a card with newlines, quotes and backslashes survives with no shell escaping', () => {
  const p = tmpProject();
  const card = 'TASK id=X-2 type=implement attempt=1 tier=medium\nWHY say "hello" and keep C:\\path\nSCOPE "quoted" $HOME `tick`';
  // Raw text on stdin, as a quoted heredoc delivers it; the card's newline is the JSON escape \n.
  const input = `{"tool":"codex","task_name":"x_2_a1","card":${JSON.stringify(card)}}\n`;
  const r = logEventWith(p, ['delegation', '-'], input);
  eq(r.status, 0, r.stderr);
  const d = readLog(p, 'delegations.jsonl');
  eq(d.length, 1, 'one line');
  eq(d[0].task.id, 'X-2', 'task id from card');
  eq(d[0].task.why, 'say "hello" and keep C:\\path', 'why keeps quotes and backslashes');
  assert(d[0].card === undefined, 'raw card not stored');
});

test('log-event stdin: empty and whitespace-only stdin are invalid JSON and write nothing', () => {
  for (const input of ['', '   \n']) {
    const p = tmpProject();
    eq(readLog(p, 'notes.jsonl').length, 0, 'precondition: no log');
    const r = logEventWith(p, ['note', '-'], input);
    eq(r.status, 1, 'exit 1');
    assert(/^invalid JSON: /.test(r.stderr), `error message: ${r.stderr}`);
    eq(readLog(p, 'notes.jsonl').length, 0, 'nothing written');
    // one step past: valid input on the same project logs exactly one line
    eq(logEventWith(p, ['note', '-'], '{"text":"after"}').status, 0, 'next valid input ok');
    eq(readLog(p, 'notes.jsonl').length, 1, 'one line after the valid call');
  }
});

test('log-event stdin: invalid JSON gives the same error and exit code as argv', () => {
  const p = tmpProject();
  const fromArgv = spawnSync('node', [path.join(SCRIPTS, 'log-event.js'), 'note', '{nope'], { cwd: p, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: p } });
  const fromStdin = logEventWith(p, ['note', '-'], '{nope');
  eq(fromStdin.status, fromArgv.status, 'exit code');
  eq(fromStdin.stderr, fromArgv.stderr, 'error message');
  assert(fromStdin.stderr.startsWith('invalid JSON: '), 'message prefix');
  eq(readLog(p, 'notes.jsonl').length, 0, 'nothing written');
});

test('log-event stdin: a non-object (array, string, null) is rejected, nothing written', () => {
  for (const input of ['[1,2]', '"text"', 'null']) {
    const p = tmpProject();
    const r = logEventWith(p, ['note', '-'], input);
    eq(r.status, 1, `exit for ${input}`);
    eq(r.stderr.trim(), 'invalid JSON: expected an object', `message for ${input}`);
    eq(readLog(p, 'notes.jsonl').length, 0, 'nothing written');
  }
});

test('log-event file: --file reads the JSON from a file, with newlines and quotes', () => {
  const p = tmpProject();
  const card = 'TASK id=X-3 type=review reviewed_task=X-2 pr=7 attempt=1\nWHY "file" form';
  const file = path.join(p, 'event.json');
  fs.writeFileSync(file, JSON.stringify({ card, verdict: 'approve', agent_id: 'r3', tool: 'codex', model: 'gpt-6.1-sol' }));
  const r = logEventWith(p, ['review', '--file', file]);
  eq(r.status, 0, r.stderr);
  const v = readLog(p, 'reviews.jsonl');
  eq(v.length, 1, 'one review');
  eq(v[0].task_id, 'X-2', 'reviewed task from the card');
  eq(v[0].pr, '7', 'pr');
  eq(v[0].verdict, 'approve', 'verdict');
  eq(v[0].tool, 'codex', 'tool');
});

test('log-event file: missing path, missing file, empty and invalid files fail with nothing written', () => {
  const p = tmpProject();
  const noPath = logEventWith(p, ['note', '--file']);
  eq(noPath.status, 1, '--file without a path: exit 1');
  assert(noPath.stderr.includes('usage: log-event.js'), 'usage printed');
  const missing = path.join(p, 'nope.json');
  const noFile = logEventWith(p, ['note', '--file', missing]);
  eq(noFile.status, 1, 'missing file: exit 1');
  assert(noFile.stderr.startsWith(`cannot read ${missing}`), `message: ${noFile.stderr}`);
  const empty = path.join(p, 'empty.json');
  fs.writeFileSync(empty, '');
  eq(logEventWith(p, ['note', '--file', empty]).status, 1, 'empty file: exit 1');
  const bad = path.join(p, 'bad.json');
  fs.writeFileSync(bad, '{nope');
  const badRun = logEventWith(p, ['note', '--file', bad]);
  eq(badRun.status, 1, 'bad JSON file: exit 1');
  assert(badRun.stderr.startsWith('invalid JSON: '), 'same error prefix');
  eq(readLog(p, 'notes.jsonl').length, 0, 'nothing written by any failure');
  // one step past: a good file on the same project logs one line
  const good = path.join(p, 'good.json');
  fs.writeFileSync(good, '{"text":"ok"}');
  eq(logEventWith(p, ['note', '--file', good]).status, 0, 'good file ok');
  eq(readLog(p, 'notes.jsonl').length, 1, 'one line');
});

test('log-event argv: the <kind> <json> form still works, and an empty argument means no JSON', () => {
  const p = tmpProject();
  eq(logEventWith(p, ['note', '{"text":"argv"}']).status, 0, 'argv ok');
  eq(readLog(p, 'notes.jsonl')[0].text, 'argv', 'argv body');
  // an empty argument is {} (unchanged behaviour), not an error
  eq(logEventWith(p, ['milestone', '']).status, 0, 'empty argv is {}');
  eq(readLog(p, 'milestones.jsonl').length, 1, 'milestone with no body');
});

test('log-event: unknown kind prints all three forms and exits 1', () => {
  const p = tmpProject();
  const r = logEventWith(p, ['bogus', '-'], '{}');
  eq(r.status, 1, 'exit 1');
  for (const form of ["'<json>'", '-', '--file <path>']) assert(r.stderr.includes(form), `usage lists ${form}`);
});
