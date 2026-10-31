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

test('broken override file: still logs from the default map and exits 0', () => {
  const bad = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-team-badmap-')), 'models.json');
  fs.writeFileSync(bad, '{ not json');
  const rec = delegate(tmpProject(), { subagent_type: 'agent-team:implementer', model: 'opus' }, {}, { AGENT_TEAM_MODELS: bad });
  eq(rec.tier, 'large', 'tier from default map');
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
