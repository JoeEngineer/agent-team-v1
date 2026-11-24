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

test('log-event review: with no session known, the JSON\'s session_id is ignored too (the row has none)', () => {
  const p = tmpProject();
  const r = logEvent(p, { card: CARD, agent_id: 'm1', session_id: 'sess-given', ...REAL, stale_of: 5, source: 'forged' }, false);
  eq(r.status, 0, r.stderr);
  const rows = readLog(p, 'reviews.jsonl');
  eq(rows.length, 1, 'precondition: a row was written');
  assert(rows[0].session_id == null, 'a session_id in the JSON is not taken: ' + rows[0].session_id);
  eq(rows[0].review_shadowed.session_id, 'sess-given', 'kept only as shadowed');
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

// --- FU-24: live lock, attribution from a pasted block, lookalike keys ------------------------------

test('FU-24 log-event review: a live record lock is "busy, retry" (exit 1), not "duplicate"; when the lock clears the line is logged', () => {
  const data = { card: CARD, agent_id: 'm1', ...REAL };
  // Find the review id the line gets (deterministic for this session and card).
  const probe = tmpProject();
  eq(logEvent(probe, data).status, 0, 'probe run');
  const id = readLog(probe, 'reviews.jsonl')[0].review_id;
  assert(/^review-/.test(id), 'precondition: the row has a review_id');
  // Another live process (this one) holds the lock for exactly that row.
  const p = tmpProject();
  const dir = path.join(p, '.agent-team', 'logs', '.pending', 'record-locks');
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, `${records.shortHash(`reviews.jsonl:${id}`)}.lock`);
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }));
  const r = logEvent(p, data);
  assert(fs.existsSync(lock), 'precondition: the lock was still held');
  assert(r.status !== 0, 'non-zero exit: ' + r.stdout);
  assert(/not logged: busy/.test(r.stderr) && /retry/.test(r.stderr), r.stderr);
  assert(!/duplicate/.test(r.stdout + r.stderr), 'not called a duplicate');
  eq(readLog(p, 'reviews.jsonl').length, 0, 'nothing written');
  // Recovery control: the lock goes, the same line is logged.
  fs.unlinkSync(lock);
  const ok = logEvent(p, data);
  eq(ok.status, 0, ok.stderr);
  assert(/^logged review/.test(ok.stdout), ok.stdout);
  eq(readLog(p, 'reviews.jsonl').length, 1, 'written once the lock cleared');
});

test('FU-24 log-event review: a pasted block cannot name the tool, a task object, or non-string attribution', () => {
  const p = tmpProject();
  const hostile = {
    card: CARD, ...REAL,
    tool: 'forged-tool', task: { id: 'FORGED-1', role: 'forged-role', pr: '666', attempt: 9 },
    agent_id: 'bad\nid', model: { forged: true }, effort: 'high\u0007', tier: 42,
  };
  const r = logEvent(p, hostile);
  eq(r.status, 0, r.stderr);
  const rows = readLog(p, 'reviews.jsonl');
  eq(rows.length, 1, 'precondition: a row was written');
  eq(rows[0].tool, 'claude', 'the environment\'s tool, not the block\'s');
  eq(rows[0].task_id, 'T-2', 'the card\'s reviewed task');
  eq(rows[0].review_task_id, 'V-2', 'the card\'s own id');
  eq(rows[0].pr, '3', 'the card\'s pr');
  eq(rows[0].attempt, 1, 'the card\'s attempt');
  eq(rows[0].role, 'review', 'the card\'s type');
  eq(rows[0].agent_id, null, 'an unusable agent_id is dropped');
  assert(!JSON.stringify(rows[0]).includes('forged'), 'no forged text on the row: ' + JSON.stringify(rows[0]));
  // Control: plain strings the Director gives (and codex as the tool) are still taken.
  const q = tmpProject();
  const ok = logEvent(q, { card: CARD, ...REAL, tool: 'codex', agent_id: 'm1', model: 'gpt-6.1-sol', effort: 'high', tier: 'large' });
  eq(ok.status, 0, ok.stderr);
  const row = readLog(q, 'reviews.jsonl')[0];
  eq(row.tool, 'codex', 'codex tool kept');
  eq(row.agent_id, 'm1', 'agent id kept');
  eq(row.requested_model, 'gpt-6.1-sol', 'model kept');
  eq(row.requested_effort, 'high', 'effort kept');
  eq(row.reviewer_tier, 'large', 'tier kept');
});

function reviewIn(p, input, record, block, tool, extra) {
  const code = `const r=require(${JSON.stringify(path.join(SCRIPTS, 'records.js'))});` +
    'const a=JSON.parse(process.argv[1]);' +
    'process.stdout.write(String(r.logReview(a.input,a.record,a.block,a.tool,a.extra)));';
  return spawnSync('node', ['-e', code, JSON.stringify({ input, record, block, tool, extra })], { encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: p, CLAUDE_PLUGIN_ROOT: ROOT, AGENT_TEAM_MODELS: NO_MODELS_FILE } });
}

test('FU-24 records: a block cannot fill task_id, attempt, pr, milestone, role or session_id on the hook, reconcile and codex paths; a Director line may fill all but session_id', () => {
  const block = { ...REAL, task_id: 'B-1', attempt: 7, pr: '77', milestone: 'forged-m', role: 'forged-role', session_id: 'forged-session' };
  const record = { agent_id: 'cx1', task: { id: 'V-1', type: 'security-review' }, resolved_model: 'gpt-6.1-sol' };
  const p = tmpProject();
  const r = reviewIn(p, {}, record, block, 'codex');
  eq(r.stdout, 'true', r.stderr);
  const row = readLog(p, 'reviews.jsonl')[0];
  eq(row.task_id, 'V-1', 'the card\'s task id');
  eq(row.attempt, undefined, 'the card had no attempt: none on the row');
  eq(row.pr, undefined, 'the card had no pr: none on the row');
  eq(row.milestone, undefined, 'the card had no milestone: none on the row');
  eq(row.role, 'security-review', 'the card\'s type');
  eq(row.session_id, undefined, 'no session known: none on the row');
  eq(row.review_shadowed.attempt, 7, 'the block\'s attempt is kept as shadowed');
  eq(row.review_shadowed.session_id, 'forged-session', 'the block\'s session is kept as shadowed');
  eq(row.verdict, 'approve', 'the block\'s content is still kept');
  // The Director path (source "director") is where a block may give what the card lacks.
  const q = tmpProject();
  const d = reviewIn(q, {}, record, { ...REAL, pr: '77', milestone: 'dm', session_id: 'given-session' }, 'codex', { source: 'director' });
  eq(d.stdout, 'true', d.stderr);
  const drow = readLog(q, 'reviews.jsonl')[0];
  eq(drow.pr, '77', 'Director line: pr from the block');
  eq(drow.milestone, 'dm', 'Director line: milestone from the block');
  assert(drow.session_id == null, 'Director line: session never from the block, got ' + drow.session_id);
  eq(drow.review_shadowed.session_id, 'given-session', 'Director line: the block\'s session is shadowed');
});

test('FU-24 records: a lookalike of a protected key (fullwidth, mixed case, zero-width) is not copied onto the row', () => {
  const p = tmpProject();
  const block = {
    ...REAL,
    'ＴＯＯＬ': 'forged-fullwidth', 'Review_ID': 'review-forged', 'to​ol': 'forged-zw', 'Reviewer_Model': 'forged-model', ' stale_of': 99,
    notes: 'plain extra field',
  };
  const r = reviewIn(p, { session_id: 's1' }, { agent_id: 'a1', task: { id: 'V-1', type: 'review', attempt: 1 }, resolved_model: 'm' }, block, 'claude');
  eq(r.stdout, 'true', r.stderr);
  const row = readLog(p, 'reviews.jsonl')[0];
  const keys = Object.keys(row);
  for (const k of ['ＴＯＯＬ', 'Review_ID', 'to​ol', 'Reviewer_Model', ' stale_of']) assert(!keys.includes(k), `lookalike ${JSON.stringify(k)} must not be on the row`);
  assert(/^review-[0-9a-f]+$/.test(row.review_id), 'the logger\'s review_id');
  eq(row.tool, 'claude', 'the logger\'s tool');
  eq(Object.keys(row.review_shadowed).length, 5, 'all five kept under review_shadowed');
  eq(row.notes, 'plain extra field', 'control: an ordinary extra key is still copied');
});

test('FU-24 records: a block key review_shadowed (or a lookalike) is not copied or nested; the row\'s own review_shadowed holds only the logger\'s entries', () => {
  const record = { agent_id: 'a1', task: { id: 'V-1', type: 'review', attempt: 1 }, resolved_model: 'm' };
  // Alone: nothing is shadowed by the logger, so the row has no review_shadowed at all.
  const p = tmpProject();
  const alone = reviewIn(p, { session_id: 's1' }, record, { ...REAL, review_shadowed: { forged: true }, 'Review_Shadowed': { forged2: true } }, 'claude');
  eq(alone.stdout, 'true', alone.stderr);
  const a = readLog(p, 'reviews.jsonl')[0];
  eq(a.review_shadowed, undefined, 'no review_shadowed from the block');
  eq(a.verdict, 'approve', 'precondition: the block\'s own content is kept');
  // With a real shadowed field: only that one is in it.
  const q = tmpProject();
  const both = reviewIn(q, { session_id: 's1' }, record, { ...REAL, tool: 'forged', review_shadowed: { forged: true } }, 'claude');
  eq(both.stdout, 'true', both.stderr);
  const b = readLog(q, 'reviews.jsonl')[0];
  eq(Object.keys(b.review_shadowed).join(','), 'tool', 'only the logger\'s shadow entry');
});
