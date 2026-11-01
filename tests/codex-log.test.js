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

test('codex: explicit spawn model overrides role-file and agent-name defaults without claiming observed settings', () => {
  for (const withRoleFile of [false, true]) {
    for (const model of ['gpt-requested', 'gpt-6-luna']) {
      const p = tmpProject();
      if (withRoleFile) {
        fs.mkdirSync(path.join(p, '.codex', 'agents'), { recursive: true });
        fs.writeFileSync(path.join(p, '.codex', 'agents', 'implementer-medium.toml'), 'model = "gpt-6.1-terra"\nmodel_reasoning_effort = "low"\n');
      }
      const input = spawn();
      input.tool_input.model = model;
      hook(p, input);
      const d = readLog(p, 'delegations.jsonl')[0];
      eq(d.model, model, 'explicit requested model');
      eq(d.model_source, 'override', 'override source');
      eq(d.tier, model === 'gpt-6-luna' ? 'small' : null, 'tier belongs to requested model, not role name');
      eq(d.tier_source, model === 'gpt-6-luna' ? 'override' : null, 'tier source');
      eq(d.effort, 'high', 'explicit requested effort');
      eq(d.resolved_model, null, 'spawn does not prove actual model');
      hook(p, stop(p, transcript(p)));
      const c = readLog(p, 'completions.jsonl')[0];
      eq(c.model, model, 'completion retains requested model');
      eq(c.resolved_model, 'gpt-6.1-terra', 'completion records transcript model separately');
    }
  }
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

test('codex: a known child turn is deduped independently of its report text', () => {
  const p = tmpProject();
  const file = transcript(p);
  hook(p, stop(p, file, { turn_id: 'turn-1' }));
  hook(p, stop(p, file, { turn_id: 'turn-1' }));
  eq(readLog(p, 'completions.jsonl').length, 1, 'duplicate dropped');
  hook(p, stop(p, file, { turn_id: 'turn-1', last_assistant_message: 'again' }));
  eq(readLog(p, 'completions.jsonl').length, 1, 'same turn remains one event');
});

const eventLine = (type, payload) => JSON.stringify({ type, payload }) + '\n';
const completeTurn = (file, id, duration) => fs.appendFileSync(file,
  eventLine('event_msg', { type: 'task_complete', turn_id: id, duration_ms: duration }));
const waitHook = (p) => hook(p, { hook_event_name: 'PostToolUse', tool_name: 'collaborationwait_agent', tool_input: { timeout_ms: 1 } });
const pendingFiles = (p) => {
  const dir = path.join(p, '.agent-team', 'logs', '.pending', 'codex-completions');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => path.join(dir, f)) : [];
};

test('codex: stop before task_complete survives restart and a later wait drains it once', () => {
  const p = tmpProject();
  directorLine(p);
  const file = transcript(p);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  fs.writeFileSync(file, lines.slice(0, -1).join('\n') + '\n');
  hook(p, stop(p, file));
  eq(readLog(p, 'completions.jsonl').length, 0, 'unfinished turn deferred');
  hook(p, stop(p, file, { last_assistant_message: 'changed callback text' }));
  completeTurn(file, 'turn-1', 1234);
  waitHook(p); // Each hook runs in a fresh Node process.
  waitHook(p);
  const cs = readLog(p, 'completions.jsonl');
  eq(cs.length, 1, 'one completion after restart');
  eq(cs[0].duration_ms, 1234, 'current turn duration');
  eq(cs[0].task.id, 'CD-7', 'frozen card');
  eq(cs[0].turn_id, 'turn-1', 'child turn identity');
  eq(cs[0].result.status, 'done', 'first stop report preserved');
});

test('codex: an earlier turn never takes later context, usage or duration', () => {
  const p = tmpProject();
  const file = transcript(p, { turns: 2 });
  const text = fs.readFileSync(file, 'utf8').replace(
    '"turn_id":"turn-2","model":"gpt-6.1-terra","effort":"high"',
    '"turn_id":"turn-2","model":"future-model","effort":"low"');
  fs.writeFileSync(file, text);
  hook(p, stop(p, file, { turn_id: 'turn-1' }));
  const c = readLog(p, 'completions.jsonl')[0];
  eq(c.resolved_model, 'gpt-6.1-terra', 'selected context');
  eq(c.resolved_effort, 'high', 'selected effort');
  eq(c.tokens, 1050, 'selected cumulative endpoint');
  eq(c.duration_ms, 1000, 'matching completion');
});

test('codex: delayed reconciliation freezes the task card and separates a reused thread new task', () => {
  const p = tmpProject();
  delegationLine(p, { card: 'TASK id=OLD type=review attempt=1', model: 'requested-old', effort: 'medium' });
  const file = transcript(p);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').trim().split('\n').slice(0, -1).join('\n') + '\n');
  const msg = '```review-json\n{"verdict":"approve","findings":[]}\n```';
  hook(p, stop(p, file, { last_assistant_message: msg }));
  delegationLine(p, { kind: 'resume', card: 'TASK id=NEW type=review attempt=1', model: 'requested-new', effort: 'low' });
  completeTurn(file, 'turn-1', 123);
  fs.appendFileSync(file,
    eventLine('event_msg', { type: 'task_started', turn_id: 'turn-2' }) +
    eventLine('turn_context', { turn_id: 'turn-2', model: 'future-model', effort: 'low' }) +
    eventLine('event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: 1500, cached_input_tokens: 600, output_tokens: 80, reasoning_output_tokens: 15, total_tokens: 1580 } } }));
  completeTurn(file, 'turn-2', 456);
  waitHook(p);
  hook(p, stop(p, file, { turn_id: 'turn-2', last_assistant_message: msg }));
  const cs = readLog(p, 'completions.jsonl');
  eq(cs.length, 2, 'two child turns');
  eq(cs[0].task.id, 'OLD', 'queued card preserved');
  eq(cs[0].model, 'requested-old', 'queued requested model');
  eq(cs[0].effort, 'medium', 'queued requested effort');
  eq(cs[0].resolved_model, 'gpt-6.1-terra', 'earlier observed model');
  eq(cs[0].tokens, 1050, 'earlier token endpoint');
  eq(cs[0].duration_ms, 123, 'earlier matching duration');
  eq(cs[1].task.id, 'NEW', 'new task card');
  eq(cs[1].task.attempt, 1, 'attempt resets for new task');
  eq(cs[1].tokens, 530, 'new task token delta');
  assert(cs[0].attempt_key !== cs[1].attempt_key, 'task identity is part of the attempt key');
  assert(cs[0].event_id !== cs[1].event_id, 'child turns have separate identities');
  const rs = readLog(p, 'reviews.jsonl');
  eq(rs.length, 2, 'identical approvals both survive');
  eq(rs[0].reviewer_effort, 'high', 'observed rather than requested reviewer effort');
  eq(rs[0].requested_effort, 'medium', 'request separately preserved');
});

test('codex: unresolved snapshots survive marker pruning and contain no raw prompt or report prose', () => {
  const p = tmpProject();
  const file = transcript(p, { turns: 2 });
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').trim().split('\n').slice(0, -1).join('\n') + '\n');
  hook(p, stop(p, file, { turn_id: 'turn-2', tool_input: { message: 'PRIVATE TOOL PROMPT' }, last_assistant_message: 'PRIVATE PROSE\n```result-json\n{"status":"done"}\n```' }));
  eq(readLog(p, 'completions.jsonl').length, 0, 'prior completed turn cannot complete this one');
  const [pending] = pendingFiles(p);
  assert(pending, 'durable pending snapshot');
  const text = fs.readFileSync(pending, 'utf8');
  assert(!text.includes('PRIVATE TOOL PROMPT') && !text.includes('PRIVATE PROSE'), 'only parsed reports retained');
  const old = new Date(Date.now() - 25 * 3600 * 1000);
  fs.utimesSync(pending, old, old);
  waitHook(p);
  eq(pendingFiles(p).length, 1, 'ordinary prune keeps unfinished snapshot');
  completeTurn(file, 'turn-2', 987);
  waitHook(p);
  eq(readLog(p, 'completions.jsonl')[0].duration_ms, 987, 'matching resumed duration');
  eq(pendingFiles(p).length, 0, 'snapshot removed after output');
  hook(p, stop(p, file, { turn_id: 'turn-2' }));
  eq(readLog(p, 'completions.jsonl').length, 1, 'durable JSONL receipt dedupes after queue removal');
});

test('codex: unknown or missing turn ids keep metrics null and legacy reports remain distinct', () => {
  const p = tmpProject();
  const file = transcript(p, { turns: 2 });
  hook(p, stop(p, file, { turn_id: 'unknown' }));
  hook(p, stop(p, file, { turn_id: null }), { AGENT_TEAM_TOOL: 'codex' });
  hook(p, stop(p, file, { turn_id: null, last_assistant_message: 'different legacy report' }), { AGENT_TEAM_TOOL: 'codex' });
  const cs = readLog(p, 'completions.jsonl');
  eq(cs.length, 3, 'legacy fallback preserves distinct reports');
  for (const c of cs) for (const field of ['duration_ms', 'tokens', 'tokens_detail', 'resolved_model', 'resolved_effort']) eq(c[field], null, `unknown ${field}`);
  eq(pendingFiles(p).length, 0, 'no guessed pending turn');
});

test('codex: a delayed exact completion after the next start does not extend the usage/context window', () => {
  const p = tmpProject();
  const file = transcript(p, { turns: 2 });
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const terminal = lines.find((l) => l.includes('task_complete') && l.includes('turn-1'));
  fs.writeFileSync(file, lines.filter((l) => l !== terminal).join('\n') + '\n');
  hook(p, stop(p, file, { turn_id: 'turn-1' }));
  eq(readLog(p, 'completions.jsonl').length, 0, 'matching completion still missing');
  fs.appendFileSync(file, terminal + '\n');
  waitHook(p);
  const c = readLog(p, 'completions.jsonl')[0];
  eq(c.duration_ms, 1000, 'exact late terminal record');
  eq(c.tokens, 1050, 'usage window ends before next turn');
  eq(c.resolved_effort, 'high', 'selected context retained');
});

test('codex: torn completion lines wait for repair; wrong-turn completion is ignored', () => {
  const p = tmpProject();
  const file = transcript(p);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  fs.writeFileSync(file, lines.slice(0, -1).join('\n') + '\n' + eventLine('event_msg', { type: 'task_complete', turn_id: 'unrelated', duration_ms: 9999 }) + '{"type":"event_msg"');
  hook(p, stop(p, file));
  eq(readLog(p, 'completions.jsonl').length, 0, 'unrelated/torn completion cannot finalize');
  fs.appendFileSync(file, ',"payload":{"type":"task_complete","turn_id":"turn-1","duration_ms":321}}\n');
  waitHook(p);
  eq(readLog(p, 'completions.jsonl')[0].duration_ms, 321, 'repaired exact completion');
});

test('codex: absent prior usage and reset counters do not fabricate resume tokens', () => {
  for (const missingBaseline of [true, false]) {
    const p = tmpProject();
    const file = transcript(p, { turns: 2 });
    const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
    let counts = 0;
    const filtered = rows.filter((e) => {
      if (e.payload && e.payload.type === 'token_count') {
        counts++;
        if (counts === 1 && missingBaseline) return false;
        if (counts === 2 && !missingBaseline) for (const k of Object.keys(e.payload.info.total_token_usage)) e.payload.info.total_token_usage[k] = 0;
      }
      return true;
    });
    fs.writeFileSync(file, filtered.map(JSON.stringify).join('\n') + '\n');
    hook(p, stop(p, file, { turn_id: 'turn-2' }));
    const c = readLog(p, 'completions.jsonl')[0];
    eq(c.tokens, null, missingBaseline ? 'missing baseline' : 'reset cumulative counters');
    eq(c.tokens_detail, null, 'unknown token details');
    eq(c.duration_ms, 2000, 'other metrics remain available');
  }
});

test('codex: token baseline requires the immediately preceding turn final usage evidence', () => {
  for (const boundary of ['known', 'missing', 'empty', 'missing-info', 'torn', 'wrong-turn', 'incomplete', 'empty-after-known', 'missing-info-after-known', 'torn-after-known']) {
    const p = tmpProject();
    const file = transcript(p, { turns: 3 });
    let turn;
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').flatMap((line) => {
      const e = JSON.parse(line), payload = e.payload || {};
      if (payload.type === 'task_started') turn = payload.turn_id;
      if (turn === 'turn-2' && payload.type === 'token_count') {
        if (boundary === 'empty-after-known') return [line, JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: {} } } })];
        if (boundary === 'missing-info-after-known') return [line, JSON.stringify({ type: 'event_msg', payload: { type: 'token_count' } })];
        if (boundary === 'torn-after-known') return [line, '{"type":"event_msg","payload":{"type":"token_count"'];
        if (boundary === 'missing') return [];
        if (boundary === 'empty') payload.info.total_token_usage = {};
        if (boundary === 'missing-info') delete payload.info;
        if (boundary === 'torn') return ['{"type":"event_msg","payload":{"type":"token_count"'];
        if (boundary === 'wrong-turn') payload.turn_id = 'turn-1';
      }
      if (turn === 'turn-2' && payload.type === 'task_complete' && boundary === 'incomplete') return [];
      return [JSON.stringify(e)];
    });
    fs.writeFileSync(file, lines.join('\n') + '\n');
    hook(p, stop(p, file, { turn_id: 'turn-3' }));
    const c = readLog(p, 'completions.jsonl')[0];
    eq(c.tokens, boundary === 'known' ? 3150 : null, `${boundary} immediately preceding endpoint`);
    eq(c.tokens_detail && c.tokens_detail.input, boundary === 'known' ? 3000 : null, `${boundary} input evidence`);
    eq(c.duration_ms, 3000, 'duration is independently known');
  }
});

test('codex: pending state recovers a dead writer lock and a failed review append', () => {
  const p = tmpProject();
  const file = transcript(p);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').trim().split('\n').slice(0, -1).join('\n') + '\n');
  hook(p, stop(p, file, { last_assistant_message: '```review-json\n{"verdict":"approve"}\n```' }));
  const [pending] = pendingFiles(p);
  const records = require(path.join(SCRIPTS, 'records.js'));
  const lockDir = path.join(p, '.agent-team', 'logs', '.pending', 'record-locks');
  const lock = path.join(lockDir, `${records.shortHash(`codex-stop:${path.basename(pending)}`)}.lock`);
  fs.writeFileSync(lock, JSON.stringify({ pid: 2147483647 }));
  const reviewFile = path.join(p, '.agent-team', 'logs', 'reviews.jsonl');
  fs.mkdirSync(reviewFile); // Make the separate review append fail after completion append.
  completeTurn(file, 'turn-1', 654);
  waitHook(p);
  eq(readLog(p, 'completions.jsonl').length, 1, 'completion committed once after dead-lock recovery');
  eq(pendingFiles(p).length, 1, 'failed review retains the snapshot');
  fs.rmdirSync(reviewFile);
  fs.unlinkSync(file); // The durable completion supplies the already captured facts.
  waitHook(p);
  eq(readLog(p, 'completions.jsonl').length, 1, 'completion receipt avoids a duplicate');
  eq(readLog(p, 'reviews.jsonl').length, 1, 'review append recovered');
  eq(pendingFiles(p).length, 0, 'snapshot removed only after both records');
});

test('codex: pending drain respects its cap and later calls make progress', () => {
  const p = tmpProject();
  const file = transcript(p);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').trim().split('\n').slice(0, -1).join('\n') + '\n');
  hook(p, stop(p, file));
  const [first] = pendingFiles(p);
  const snapshot = JSON.parse(fs.readFileSync(first, 'utf8'));
  const dir = path.dirname(first);
  for (let n = 1; n <= 2; n++) {
    const event_id = `codex-${String(n).padStart(12, '0')}`;
    fs.writeFileSync(path.join(dir, `${event_id}.json`), JSON.stringify({ ...snapshot, record: { ...snapshot.record, event_id, agent_id: `other-${n}` } }));
  }
  completeTurn(file, 'turn-1', 123);
  const invoke = () => spawnSync('node', ['-e', 'const c=require(process.argv[1]); process.stdout.write(JSON.stringify(c.drainPending({cwd:process.cwd()},{cap:1})));', path.join(SCRIPTS, 'codex-log.js')], { cwd: p, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: p, AGENT_TEAM_MODELS: NO_MODELS_FILE } });
  const firstRun = invoke();
  eq(firstRun.status, 0, 'drain exit');
  eq(JSON.parse(firstRun.stdout).checked, 1, 'one snapshot checked');
  eq(readLog(p, 'completions.jsonl').length, 1, 'one completion at cap one');
  invoke();
  invoke();
  eq(readLog(p, 'completions.jsonl').length, 3, 'remaining calls complete the queue');
  eq(pendingFiles(p).length, 0, 'queue exhausted');
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

test('codex: a hook run prunes old stop-/resume- markers, keeps a fresh one and hooks-alive.json', () => {
  const p = tmpProject();
  const dir = path.join(p, '.agent-team', 'logs', '.pending');
  fs.mkdirSync(dir, { recursive: true });
  const old = new Date(Date.now() - 25 * 3600 * 1000);
  for (const n of ['stop-old', 'resume-old']) { fs.writeFileSync(path.join(dir, n), ''); fs.utimesSync(path.join(dir, n), old, old); }
  fs.writeFileSync(path.join(dir, 'resume-new'), '');
  fs.writeFileSync(path.join(dir, 'hooks-alive.json'), '{}');
  fs.utimesSync(path.join(dir, 'hooks-alive.json'), old, old);
  assert(fs.existsSync(path.join(dir, 'stop-old')) && fs.existsSync(path.join(dir, 'resume-old')), 'precondition: old markers exist');
  hook(p, spawn());
  eq(fs.readdirSync(dir).sort().join(','), 'hooks-alive.json,resume-new', 'old markers pruned, fresh marker and hooks-alive.json kept');
  hook(p, spawn({ tool_use_id: 'call_2' }));
  eq(fs.readdirSync(dir).sort().join(','), 'hooks-alive.json,resume-new', 'a further run changes nothing');
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
