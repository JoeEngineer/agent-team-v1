// Tests for tier / tier_source / billing / reviewer_tier in the delegation logs
// and the tier_fallback event. Loaded by tests/run.js.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { tmpProject, run, readLog, test, assert, eq } = require('./helpers');

console.log('tier-logging');

const card = 'TASK id=T-1 type=implement difficulty=medium milestone=m attempt=1';
function delegate(proj, ti, resp = {}, env = {}) {
  const r = run('log-delegation.js', {
    hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: 'tu',
    tool_input: { prompt: card, ...ti }, tool_response: resp,
  }, proj, env);
  eq(r.status, 0, 'hook exits 0');
  const recs = readLog(proj, 'delegations.jsonl');
  return recs[recs.length - 1];
}

test('agent-file model gives tier medium, source agent-file (agent file has only model:)', () => {
  const rec = delegate(tmpProject(), { subagent_type: 'agent-team:implementer' });
  eq(rec.model_source, 'agent-file', 'precondition: model came from agent file');
  eq(rec.tier, 'medium', 'tier');
  eq(rec.tier_source, 'agent-file', 'tier source');
  assert(!('billing' in rec), 'no billing on a plain tier');
});

test('override opus gives tier large, source override', () => {
  const rec = delegate(tmpProject(), { subagent_type: 'agent-team:implementer', model: 'opus' });
  eq(rec.model_source, 'override', 'precondition');
  eq(rec.tier, 'large', 'tier');
  eq(rec.tier_source, 'override', 'tier source');
});

test('override fable gives tier xlarge with billing credits', () => {
  const rec = delegate(tmpProject(), { subagent_type: 'agent-team:implementer', model: 'fable' });
  eq(rec.tier, 'xlarge', 'tier');
  eq(rec.billing, 'credits', 'billing');
});

test('unknown override model gives tier null', () => {
  const rec = delegate(tmpProject(), { subagent_type: 'agent-team:implementer', model: 'mystery-9' });
  eq(rec.model, 'mystery-9', 'precondition: override recorded');
  eq(rec.tier, null, 'tier');
  eq(rec.tier_source, null, 'tier source');
});

test('inherited agent: tier from the resolved model, in delegation and completion', () => {
  const proj = tmpProject();
  fs.mkdirSync(path.join(proj, '.claude', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.claude', 'agents', 'inh.md'), '---\nname: inh\ndescription: x\n---\nbody\n');
  const rec = delegate(proj, { subagent_type: 'inh' }, { isAsync: true, status: 'async_launched', agentId: 'i1', resolvedModel: 'claude-haiku-5-5' });
  eq(rec.model, 'inherited', 'precondition: model inherited');
  eq(rec.tier, 'small', 'delegation tier');
  eq(rec.tier_source, 'resolved', 'delegation tier source');

  const tdir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-team-tier-'));
  const file = path.join(tdir, 'agent-i1.jsonl');
  const lines = [
    { type: 'user', timestamp: '2026-10-30T18:33:35.000Z', message: { role: 'user', content: card } },
    { type: 'assistant', timestamp: '2026-10-30T18:33:37.000Z', message: { id: 'm1', model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'done' }] } },
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  // No delegation line for this agent id: the completion must resolve the tier itself.
  run('log-delegation.js', { hook_event_name: 'SubagentStop', agent_id: 'nodeleg', agent_type: 'inh', agent_transcript_path: file }, proj);
  const c = readLog(proj, 'completions.jsonl')[0];
  eq(c.resolved_model, 'claude-haiku-5-5', 'precondition: resolved model');
  eq(c.tier, 'small', 'completion tier');
  eq(c.tier_source, 'resolved', 'completion tier source');
  // With a delegation line, the completion carries the delegation's tier.
  run('log-delegation.js', { hook_event_name: 'SubagentStop', agent_id: 'i1', agent_type: 'inh', agent_transcript_path: file }, proj);
  eq(readLog(proj, 'completions.jsonl')[1].tier, 'small', 'linked completion tier');
});

test('agent file tier: key wins over the model when present', () => {
  const proj = tmpProject();
  fs.mkdirSync(path.join(proj, '.claude', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.claude', 'agents', 'tiered.md'), '---\nname: tiered\ndescription: x\nmodel: sonnet\ntier: large\n---\n');
  const rec = delegate(proj, { subagent_type: 'tiered' });
  eq(rec.model_source, 'agent-file', 'precondition');
  eq(rec.tier, 'large', 'tier from frontmatter');
  eq(rec.tier_source, 'agent-file', 'source');
});

test('broken override file: falls back to the default map, unlike a valid override; exits 0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-team-badmap-'));
  const good = path.join(dir, 'good.json');
  // A valid override that puts opus on the medium tier (default map: large).
  fs.writeFileSync(good, JSON.stringify({ small: { claude: 'haiku' }, medium: { claude: 'opus' }, large: { claude: 'other' } }));
  const viaGood = delegate(tmpProject(), { subagent_type: 'agent-team:implementer', model: 'opus' }, {}, { AGENT_TEAM_MODELS: good });
  eq(viaGood.tier, 'medium', 'precondition: a valid override file is read');
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, '{ not json');
  const rec = delegate(tmpProject(), { subagent_type: 'agent-team:implementer', model: 'opus' }, {}, { AGENT_TEAM_MODELS: bad });
  eq(rec.tier, 'large', 'default map used, not the override and not null');
});

test('a linked completion for a non-inherited agent reuses the delegation tier', () => {
  const proj = tmpProject();
  const rec = delegate(proj, { subagent_type: 'agent-team:implementer', model: 'opus' }, { isAsync: true, status: 'async_launched', agentId: 'n1', resolvedModel: 'claude-opus-5-5' });
  eq(rec.tier_source, 'override', 'precondition: delegation tier from override');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-team-tier-')), 'agent-n1.jsonl');
  const lines = [
    { type: 'user', timestamp: '2026-10-30T18:33:35.000Z', message: { role: 'user', content: card } },
    // A transcript model that maps to a different tier: the delegation's tier must win.
    { type: 'assistant', timestamp: '2026-10-30T18:33:37.000Z', message: { id: 'm1', model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'done' }] } },
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  run('log-delegation.js', { hook_event_name: 'SubagentStop', agent_id: 'n1', agent_type: 'agent-team:implementer', agent_transcript_path: file }, proj);
  const [c] = readLog(proj, 'completions.jsonl');
  eq(c.tier, 'large', 'tier from delegation');
  eq(c.tier_source, 'override', 'tier source from delegation');
});

test('resume (SendMessage) reuses the prior delegation tier', () => {
  const proj = tmpProject();
  delegate(proj, { subagent_type: 'agent-team:implementer', model: 'fable' }, { isAsync: true, status: 'async_launched', agentId: 'rs1' });
  const r = run('log-delegation.js', {
    hook_event_name: 'PostToolUse', tool_name: 'SendMessage', tool_use_id: 'tu2',
    tool_input: { to: 'rs1', message: card.replace('attempt=1', 'attempt=2') }, tool_response: {},
  }, proj);
  eq(r.status, 0, 'exit 0');
  const recs = readLog(proj, 'delegations.jsonl');
  eq(recs.length, 2, 'precondition: resume record written');
  eq(recs[1].kind, 'resume', 'kind');
  eq(recs[1].tier, 'xlarge', 'tier from prior delegation');
  eq(recs[1].tier_source, 'override', 'tier source from prior delegation');
  eq(recs[1].billing, 'credits', 'billing carried');
});

test('session record with an explicit model carries tier', () => {
  const proj = tmpProject();
  const r = run('log-delegation.js', {
    hook_event_name: 'PostToolUse', tool_name: 'mcp__ccd_session__start_session', tool_use_id: 'tu3',
    tool_input: { model: 'opus', title: 't', prompt: card }, tool_response: 'started local_abc',
  }, proj);
  eq(r.status, 0, 'exit 0');
  const [rec] = readLog(proj, 'delegations.jsonl');
  eq(rec.kind, 'session', 'precondition: session record');
  eq(rec.model_source, 'override', 'model from override');
  eq(rec.tier, 'large', 'tier');
  eq(rec.tier_source, 'override', 'tier source');
});

test('pinned: model: inherit with a tier: key takes the tier from the resolved model', () => {
  // Decision: the tier logged is the model that actually ran, so an inherit
  // agent that declares tier: large but ran on haiku is logged as small.
  const proj = tmpProject();
  fs.mkdirSync(path.join(proj, '.claude', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.claude', 'agents', 'inht.md'), '---\nname: inht\ndescription: x\nmodel: inherit\ntier: large\n---\n');
  const rec = delegate(proj, { subagent_type: 'inht' }, { isAsync: true, status: 'async_launched', agentId: 'p1', resolvedModel: 'claude-haiku-5-5' });
  eq(rec.model_source, 'inherited', 'precondition: model inherited');
  eq(rec.tier, 'small', 'tier from resolved model, not the tier: key');
  eq(rec.tier_source, 'resolved', 'tier source');
});

test('reviewer delegation: review record carries reviewer_tier', () => {
  const proj = tmpProject();
  const text = '```review-json\n{"verdict":"approve","severity":"none","issues":[],"summary":"ok"}\n```';
  delegate(proj, { subagent_type: 'agent-team:reviewer', model: 'opus' }, { content: [{ type: 'text', text }] });
  const [rv] = readLog(proj, 'reviews.jsonl');
  assert(rv, 'precondition: review logged');
  eq(rv.reviewer_tier, 'large', 'reviewer tier');
});

test('log-event tier_fallback writes tier_fallbacks.jsonl', () => {
  const proj = tmpProject();
  const logEvent = path.join(__dirname, '..', 'scripts', 'log-event.js');
  const env = { ...process.env, CLAUDE_PROJECT_DIR: proj };
  const bare = spawnSync('node', [logEvent], { encoding: 'utf8', env });
  eq(bare.status, 1, 'precondition: bare call rejected');
  eq(readLog(proj, 'tier_fallbacks.jsonl').length, 0, 'nothing logged yet');
  const data = { task: 'X-1', from: 'large', to: 'medium', tool: 'claude', reason: 'model unavailable' };
  const r = spawnSync('node', [logEvent, 'tier_fallback', JSON.stringify(data)], { encoding: 'utf8', env });
  eq(r.status, 0, 'exit 0');
  const [rec] = readLog(proj, 'tier_fallbacks.jsonl');
  eq(rec.task, 'X-1', 'task');
  eq(rec.to, 'medium', 'to');
  assert(rec.ts, 'timestamped');
});
