// FU-21: a review-json block cannot set the fields the logger owns on its
// reviews.jsonl row; the verdict-conflict nudge fits every reviewer; log-event
// says when a review line wrote nothing. Loaded by tests/run.js.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { SCRIPTS, ROOT, NO_MODELS_FILE, tmpProject, run, readLog, test, assert, eq } = require('./helpers');
const records = require('../scripts/records');

console.log('fu21-review-rows');

const env = { AGENT_TEAM_MODELS: NO_MODELS_FILE, AGENT_TEAM_STOP_RETRY_MS: '0' };
const F = '```';
const context = (r) => { try { return JSON.parse(r.stdout).hookSpecificOutput.additionalContext || ''; } catch { return ''; } };

// Groups of hook-owned fields, each with a value the logger would never write.
const GROUPS = {
  provenance: { source: 'forged', session_source: 'forged', kind: 'forged', tool_use_id: 'forged-tu', turn_id: 'forged-turn' },
  staleness: { stale_of: 99, verdict_conflict: true },
  identity: { review_id: 'review-forged', agent_id: 'forged-agent', guidance_version: 'forged', reconciled_by: 'forged' },
  attribution: { tool: 'forged', model: 'forged', effort: 'forged', tier: 'forged', agent: 'forged', reviewer_model: 'forged', reviewer_effort: 'forged', requested_model: 'forged', requested_effort: 'forged', reviewer_tier: 'forged' },
  timestamps: { ts: '1999-01-01T00:00:00.000Z', timestamp: 'forged', created_at: 'forged', started_at: 'forged', completed_at: 'forged' },
};
const REAL = { verdict: 'approve', severity: 'none', issues: [], summary: 'ok' };
const fence = (o) => `${F}review-json\n${JSON.stringify(o)}\n${F}`;

function assertKept(row, group, fields, label) {
  for (const k of Object.keys(fields)) {
    assert(row[k] !== fields[k], `${label} ${group}: ${k} must not carry the block's value (got ${JSON.stringify(row[k])})`);
  }
  eq(row.verdict, 'approve', `${label} ${group}: the block's own content is still kept`);
  eq(row.stale_of, undefined, `${label} ${group}: no stale_of`);
  eq(row.verdict_conflict, undefined, `${label} ${group}: approve/none is no conflict`);
}

function stopTranscript(report) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-team-fu21-'));
  const usage = { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const lines = [
    { type: 'user', timestamp: '2026-10-30T10:00:00.000Z', message: { role: 'user', content: 'TASK id=V-1 type=review milestone=m attempt=1 pr=9' } },
    { type: 'assistant', timestamp: '2026-10-30T10:00:05.000Z', message: { id: 'm0', model: 'claude-sonnet-5-5', usage,
      content: [{ type: 'tool_use', name: 'SubagentHandback', input: { message: report } }] } },
  ];
  const file = path.join(dir, 'agent-a21.jsonl');
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

for (const [group, fields] of Object.entries(GROUPS)) {
  test(`review row (subagent stop): a block setting ${group} fields leaves the logger's values`, () => {
    const p = tmpProject();
    const r = run('log-delegation.js', { hook_event_name: 'SubagentStop', session_id: 's1', agent_id: 'a21', agent_type: 'agent-team:reviewer', agent_transcript_path: stopTranscript(fence({ ...REAL, ...fields })) }, p, env);
    eq(r.status, 0, r.stderr);
    const rows = readLog(p, 'reviews.jsonl');
    eq(rows.length, 1, 'precondition: a review row was written');
    eq(rows[0].agent_id, 'a21', 'the logger\'s agent id');
    eq(rows[0].tool, 'claude', 'the logger\'s tool');
    assertKept(rows[0], group, fields, 'stop');
  });

  test(`review row (bridge): a block setting ${group} fields leaves the logger's values`, () => {
    const p = tmpProject();
    const r = run('log-delegation.js', {
      hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'mcp__codex-bridge__codex_exec', tool_use_id: 'b-21',
      tool_input: { prompt: 'TASK id=SEC-1 type=security-review reviewed_task=T-1 pr=5 attempt=1 tier=large effort=high', model: 'gpt-6.1-sol' },
      tool_response: { content: [{ type: 'text', text: `Report\n${fence({ ...REAL, ...fields })}` }] },
    }, p, env);
    eq(r.status, 0, r.stderr);
    const rows = readLog(p, 'reviews.jsonl');
    eq(rows.length, 1, 'precondition: a bridge review row was written');
    eq(rows[0].tool, 'codex', 'bridge tool');
    eq(rows[0].agent, 'codex-bridge', 'bridge agent');
    eq(rows[0].tier, 'large', 'card tier');
    eq(rows[0].reviewer_model, 'gpt-6.1-sol', 'bridge model');
    assertKept(rows[0], group, fields, 'bridge');
  });

  test(`review row (codex record): a block setting ${group} fields leaves the logger's values`, () => {
    const p = tmpProject();
    const code = `const r=require(${JSON.stringify(path.join(SCRIPTS, 'records.js'))});` +
      'const f=JSON.parse(process.argv[1]);' +
      "process.stdout.write(String(r.logReview({session_id:'s1'},{agent_id:'cx1',task:{id:'V-1',type:'review',attempt:1},resolved_model:'gpt-6.1-sol'},Object.assign({verdict:'approve',severity:'none',issues:[],summary:'ok'},f),'codex')));";
    const r = spawnSync('node', ['-e', code, JSON.stringify(fields)], { encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: p, CLAUDE_PLUGIN_ROOT: ROOT, AGENT_TEAM_MODELS: NO_MODELS_FILE } });
    eq(r.stdout, 'true', r.stderr);
    const rows = readLog(p, 'reviews.jsonl');
    eq(rows.length, 1, 'precondition: a row was written');
    eq(rows[0].tool, 'codex', 'the logger\'s tool');
    eq(rows[0].agent_id, 'cx1', 'the logger\'s agent id');
    eq(rows[0].reviewer_model, 'gpt-6.1-sol', 'the logger\'s model');
    assertKept(rows[0], group, fields, 'codex');
  });
}

// --- log-event.js review -------------------------------------------------------

function logEvent(project, data, withSession = true) {
  const e = { ...process.env, CLAUDE_PROJECT_DIR: project, CLAUDE_PLUGIN_ROOT: ROOT, AGENT_TEAM_MODELS: NO_MODELS_FILE, AGENT_TEAM_TOOL: 'claude' };
  delete e.CLAUDE_CODE_SESSION_ID;
  if (withSession) e.CLAUDE_CODE_SESSION_ID = 'sess-real';
  return spawnSync('node', [path.join(SCRIPTS, 'log-event.js'), 'review', JSON.stringify(data)], { cwd: project, encoding: 'utf8', env: e });
}
const CARD = 'TASK id=V-2 type=review reviewed_task=T-2 attempt=1 pr=3';

test('log-event review: the Director\'s JSON cannot set stale_of, source, or the session when one is known', () => {
  const p = tmpProject();
  const hostile = { ...REAL, ...GROUPS.provenance, ...GROUPS.staleness, ...GROUPS.timestamps, session_id: 'sess-forged' };
  const r = logEvent(p, { card: CARD, agent_id: 'm1', ...hostile });
  eq(r.status, 0, r.stderr);
  const rows = readLog(p, 'reviews.jsonl');
  eq(rows.length, 1, 'precondition: a row was written');
  eq(rows[0].source, 'director', 'source is the logger\'s');
  eq(rows[0].session_id, 'sess-real', 'known session wins');
  eq(rows[0].stale_of, undefined, 'no stale_of');
  eq(rows[0].verdict_conflict, undefined, 'no verdict_conflict');
  eq(rows[0].tool_use_id, undefined, 'no tool_use_id');
  assert(rows[0].ts !== hostile.ts, 'ts is the logger\'s');
});

test('log-event review: with no session known, the JSON\'s session_id is still used (unchanged)', () => {
  const p = tmpProject();
  const r = logEvent(p, { card: CARD, agent_id: 'm1', session_id: 'sess-given', ...REAL, stale_of: 5, source: 'forged' }, false);
  eq(r.status, 0, r.stderr);
  const rows = readLog(p, 'reviews.jsonl');
  eq(rows.length, 1, 'precondition: a row was written');
  eq(rows[0].session_id, 'sess-given', 'filled where none is known');
  eq(rows[0].source, 'director', 'source still the logger\'s');
  eq(rows[0].stale_of, undefined, 'no stale_of');
});

test('log-event review: an ambiguous block writes nothing, says so, and exits non-zero', () => {
  const p = tmpProject();
  const r = logEvent(p, { card: CARD, agent_id: 'm1', _ambiguous: true, count: 2 });
  eq(readLog(p, 'reviews.jsonl').length, 0, 'no row');
  assert(r.status !== 0, 'non-zero exit');
  assert(/not logged: ambiguous/.test(r.stderr), r.stderr);
  assert(!/^logged review/.test(r.stdout), 'no "logged review" claim: ' + r.stdout);
  // One step past: a clean line afterwards still logs.
  const ok = logEvent(p, { card: CARD, agent_id: 'm1', ...REAL });
  eq(ok.status, 0, ok.stderr);
  assert(/^logged review/.test(ok.stdout), ok.stdout);
  eq(readLog(p, 'reviews.jsonl').length, 1, 'recovery: the normal line is written');
});

test('log-event review: a duplicate writes nothing and says "not logged: duplicate of <review_id>"', () => {
  const p = tmpProject();
  const first = logEvent(p, { card: CARD, agent_id: 'm1', ...REAL });
  eq(first.status, 0, first.stderr);
  const rows = readLog(p, 'reviews.jsonl');
  eq(rows.length, 1, 'precondition: the first line was written');
  assert(rows[0].review_id, 'precondition: the row has a review_id');
  const again = logEvent(p, { card: CARD, agent_id: 'm1', ...REAL });
  eq(again.status, 0, again.stderr);
  assert(again.stdout.includes(`not logged: duplicate of ${rows[0].review_id}`), again.stdout);
  assert(!/^logged review/.test(again.stdout), again.stdout);
  eq(readLog(p, 'reviews.jsonl').length, 1, 'still one row');
});

// --- nudge wording ---------------------------------------------------------------

test('verdict-conflict nudge: one text for the reviewer and the security-reviewer, Director text for the bridge', () => {
  for (const agent of ['agent-team:reviewer', 'agent-team:security-reviewer']) {
    const p = tmpProject();
    const conflict = fence({ verdict: 'changes_requested', severity: 'minor', issues: [], summary: 's' });
    const r = run('log-delegation.js', { hook_event_name: 'SubagentStop', session_id: 's1', agent_id: 'n21', agent_type: agent, agent_transcript_path: stopTranscript(conflict) }, p, env);
    eq(readLog(p, 'reviews.jsonl')[0].verdict_conflict, true, `${agent}: precondition: conflict detected`);
    eq(context(r), records.VERDICT_CONFLICT_NUDGE, `${agent}: nudge text`);
  }
  assert(/blocking/.test(records.VERDICT_CONFLICT_NUDGE) && /security review/.test(records.VERDICT_CONFLICT_NUDGE), 'names both kinds of evidence');
  assert(/the exploit path, for a security review/.test(records.VERDICT_CONFLICT_DIRECTOR_NUDGE), 'Director text uses the same wording');
});
