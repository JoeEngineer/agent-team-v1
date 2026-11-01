// Tests for the Coach-requested logger fields: turn, milestone, pause events,
// reconcile attempt matching and stale_of, tier_mismatch, and the missing
// JSON block nudge. Loaded by tests/run.js.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { SCRIPTS, ROOT, NO_MODELS_FILE, tmpProject, run, fakeGh, readLog, test, assert, eq } = require('./helpers');

console.log('coach-logger');

const usage = { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const REVIEW = (v, summary) => '```review-json\n{"verdict":"' + v + '","severity":"none","issues":[],"summary":"' + summary + '"}\n```';

const logsOf = (proj) => path.join(proj, '.agent-team', 'logs');
function appendLog(proj, file, rows) {
  fs.mkdirSync(logsOf(proj), { recursive: true });
  fs.appendFileSync(path.join(logsOf(proj), file), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

// A subagent transcript with one turn per report; turn n carries `attempt=n`.
function transcript(dir, agentId, reports, card = (n) => `TASK id=RC-1 type=review milestone=rc attempt=${n} pr=9`) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `agent-${agentId}.jsonl`);
  const lines = [];
  reports.forEach((report, i) => {
    const ts = (s) => `2026-10-30T1${i}:00:${s}.000Z`;
    lines.push({ type: 'user', isMeta: i > 0, timestamp: ts('00'), message: { role: 'user', content: card(i + 1) } });
    lines.push({ type: 'assistant', timestamp: ts('05'), message: { id: `m${i}`, model: 'claude-sonnet-5-5', usage, content: [{ type: 'tool_use', name: 'SubagentHandback', input: { message: report } }] } });
  });
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

function stop(proj, file, agentId, agentType, env = {}) {
  return run('log-delegation.js', { hook_event_name: 'SubagentStop', agent_id: agentId, agent_type: agentType, agent_transcript_path: file }, proj, { AGENT_TEAM_STOP_RETRY_MS: '0', ...env });
}

// G9: turn on completion lines

test('completion lines carry a 1-based turn: one line per turn of a resumed agent', () => {
  const proj = tmpProject();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-team-tr-'));
  const file = transcript(dir, 'tn1', [REVIEW('changes_requested', 'one')]);
  stop(proj, file, 'tn1', 'agent-team:reviewer');
  const file2 = transcript(dir, 'tn1', [REVIEW('changes_requested', 'one'), REVIEW('approve', 'two')]);
  stop(proj, file2, 'tn1', 'agent-team:reviewer');
  const cs = readLog(proj, 'completions.jsonl');
  eq(cs.length, 2, 'precondition: one line per turn');
  eq(cs[0].turn, 1, 'first turn');
  eq(cs[1].turn, 2, 'second turn');
  eq(cs[1].review.verdict, 'approve', 'turn 2 carries its own verdict');
});

// G4: milestone on reviews, notes, escalations and merges

const delegationFor = (id, milestone) => ({ ts: 't', tool: 'claude', kind: 'subagent', agent_id: 'a-' + id, task: { id, type: 'implement', ...(milestone ? { milestone } : {}) } });

function logEvent(proj, kind, json) {
  return spawnSync('node', [path.join(SCRIPTS, 'log-event.js'), kind, '-'], {
    input: JSON.stringify(json), encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj, CLAUDE_PLUGIN_ROOT: ROOT },
  });
}

test('review lines take milestone from the reviewed task delegation card; a card milestone wins; none when unknown', () => {
  const proj = tmpProject();
  appendLog(proj, 'delegations.jsonl', [delegationFor('X-1', 'm1'), delegationFor('X-9', null)]);
  eq(logEvent(proj, 'review', { card: 'TASK id=X-2 type=review reviewed_task=X-1 attempt=1', verdict: 'approve', agent_id: 'r1' }).status, 0, 'exit');
  eq(logEvent(proj, 'review', { card: 'TASK id=X-3 type=review reviewed_task=X-1 milestone=own attempt=1', verdict: 'approve', agent_id: 'r2' }).status, 0, 'exit');
  eq(logEvent(proj, 'review', { card: 'TASK id=X-4 type=review reviewed_task=X-9 attempt=1', verdict: 'approve', agent_id: 'r3' }).status, 0, 'exit');
  eq(logEvent(proj, 'review', { card: 'TASK id=X-5 type=review attempt=1', verdict: 'approve', agent_id: 'r4' }).status, 0, 'exit');
  const rs = readLog(proj, 'reviews.jsonl');
  eq(rs.length, 4, 'precondition: four reviews');
  eq(rs[0].milestone, 'm1', 'copied from the linked delegation');
  eq(rs[1].milestone, 'own', 'card milestone wins');
  assert(!('milestone' in rs[2]), 'delegation without a milestone: no field');
  assert(!('milestone' in rs[3]), 'no linked task: no field');
});

test('hook-seen review (SubagentStop) gets the milestone from the reviewed task delegation', () => {
  const proj = tmpProject();
  appendLog(proj, 'delegations.jsonl', [delegationFor('RC-0', 'hookm')]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-team-tr-'));
  const file = transcript(dir, 'hm1', [REVIEW('approve', 'ok')], (n) => `TASK id=RC-1 type=review reviewed_task=RC-0 attempt=${n} pr=9`);
  stop(proj, file, 'hm1', 'agent-team:reviewer');
  const [r] = readLog(proj, 'reviews.jsonl');
  eq(r.milestone, 'hookm', 'milestone');
});

test('note and escalation lines take milestone from the linked task; explicit value wins; unlinked stays bare', () => {
  const proj = tmpProject();
  appendLog(proj, 'delegations.jsonl', [delegationFor('X-1', 'm1')]);
  eq(logEvent(proj, 'note', { task: 'X-1', text: 'n' }).status, 0, 'exit');
  eq(logEvent(proj, 'escalation', { task_id: 'X-1', from: 'medium', to: 'large' }).status, 0, 'exit');
  eq(logEvent(proj, 'escalation', { task: 'X-1', milestone: 'given' }).status, 0, 'exit');
  eq(logEvent(proj, 'note', { text: 'no task' }).status, 0, 'exit');
  eq(logEvent(proj, 'note', { task: 'X-404' }).status, 0, 'exit');
  const notes = readLog(proj, 'notes.jsonl');
  const [e1, e2] = readLog(proj, 'escalations.jsonl');
  eq(notes.length, 3, 'precondition: three notes');
  eq(notes[0].milestone, 'm1', 'note');
  eq(e1.milestone, 'm1', 'escalation');
  eq(e2.milestone, 'given', 'explicit milestone wins');
  assert(!('milestone' in notes[1]) && !('milestone' in notes[2]), 'no linked task: no field');
});

test('merge lines take milestone from a milestone/<name> base; other bases have none', () => {
  const proj = tmpProject();
  const merge = (n, base) => run('log-delegation.js', { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: `gh pr merge ${n} --squash` }, tool_response: { stdout: '' } }, proj,
    fakeGh(JSON.stringify({ number: n, state: 'MERGED', autoMergeRequest: null, baseRefName: base })));
  merge(1, 'milestone/live-data');
  merge(2, 'main');
  merge(3, 'milestone/');
  const [a, b, c] = readLog(proj, 'merges.jsonl');
  eq(a.milestone, 'live-data', 'milestone base');
  assert(!('milestone' in b), 'main base: no milestone');
  assert(!('milestone' in c), 'empty name: no milestone');
});

// G6: pause events

test('log-event pause: stdin form writes pauses.jsonl with reason, note and until', () => {
  const proj = tmpProject();
  const r = logEvent(proj, 'pause', { reason: 'runway', note: 'window 95%', until: '2026-11-01T17:00:00Z' });
  eq(r.status, 0, `exit: ${r.stderr}`);
  const [p] = readLog(proj, 'pauses.jsonl');
  eq(p.reason, 'runway', 'reason');
  eq(p.note, 'window 95%', 'note');
  eq(p.until, '2026-11-01T17:00:00Z', 'until');
  assert(p.ts && p.guidance_version, 'ts and guidance_version');
  eq(logEvent(proj, 'pause', { reason: 'user' }).status, 0, 'reason user without note');
  eq(readLog(proj, 'pauses.jsonl').length, 2, 'two lines');
});

test('log-event pause: a missing or unknown reason is rejected and nothing is written', () => {
  const proj = tmpProject();
  for (const bad of [{}, { reason: 'lunch' }, { note: 'x' }]) {
    const r = logEvent(proj, 'pause', bad);
    eq(r.status, 1, `exit for ${JSON.stringify(bad)}`);
    assert(/reason/.test(r.stderr), r.stderr);
  }
  eq(readLog(proj, 'pauses.jsonl').length, 0, 'no lines');
});

// G1/G2: reconcile

function reconcileSetup(agentId, reports, hookRows) {
  const proj = tmpProject();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-team-projects-'));
  const file = transcript(path.join(root, 'folder', 'sess-1', 'subagents'), agentId, reports);
  fs.writeFileSync(file.replace(/\.jsonl$/, '.meta.json'), JSON.stringify({ agentType: 'agent-team:reviewer' }));
  const del = (kind, attempt) => ({ ts: 't', tool: 'claude', session_id: 'sess-1', kind, agent: 'agent-team:reviewer', agent_id: agentId, guidance_version: '0.3.0', model: 'sonnet', effort: 'high', tier: 'medium', background: true, task: { id: 'RC-1', type: 'review', attempt, pr: '9' } });
  appendLog(proj, 'delegations.jsonl', [del('subagent', 1), ...reports.slice(1).map((_, i) => del('resume', i + 2))]);
  return { proj, root, hookRows };
}
const reconcile = (s, args = []) => spawnSync('node', [path.join(SCRIPTS, 'reconcile-logs.js'), ...args], {
  encoding: 'utf8', cwd: s.proj,
  env: { ...process.env, CLAUDE_PROJECT_DIR: s.proj, CLAUDE_PLUGIN_ROOT: ROOT, AGENT_TEAM_PROJECTS_ROOT: s.root, AGENT_TEAM_MODELS: NO_MODELS_FILE },
});
const parsed = (report) => JSON.parse(report.replace(/```review-json\n|\n```/g, ''));

test('reconcile: 3-turn reviewer with hook lines shifted one attempt ends with one correct verdict per attempt', () => {
  const reports = [REVIEW('changes_requested', 'one'), REVIEW('changes_requested', 'two'), REVIEW('approve', 'three')];
  const s = reconcileSetup('sh1', reports);
  // The 0.3.0 hook wrote turn n's report under attempt n+1, and turn 3's never arrived.
  const shifted = (att, report) => ({ ts: 't', tool: 'claude', kind: 'completion', agent_id: 'sh1', guidance_version: '0.3.0', task: { id: 'RC-1', attempt: att }, review: parsed(report) });
  appendLog(s.proj, 'completions.jsonl', [shifted(2, reports[0]), shifted(3, reports[1])]);
  appendLog(s.proj, 'reviews.jsonl', [{ agent_id: 'sh1', task_id: 'RC-1', attempt: 2, ...parsed(reports[0]) }, { agent_id: 'sh1', task_id: 'RC-1', attempt: 3, ...parsed(reports[1]) }]);
  const r = reconcile(s);
  eq(r.status, 0, r.stderr);
  const expected = { 1: ['changes_requested', 'one'], 2: ['changes_requested', 'two'], 3: ['approve', 'three'] };
  const live = (rows, pick) => rows.filter((x) => x.stale_of == null).filter((x) => String(pick(x)) !== '');
  const cs = readLog(s.proj, 'completions.jsonl');
  const rs = readLog(s.proj, 'reviews.jsonl');
  for (const att of [1, 2, 3]) {
    const cl = live(cs, (x) => x.task.attempt).filter((x) => String(x.task.attempt) === String(att));
    eq(cl.length, 1, `attempt ${att}: exactly one live completion`);
    eq(cl[0].review.verdict, expected[att][0], `attempt ${att} completion verdict`);
    eq(cl[0].review.summary, expected[att][1], `attempt ${att} completion summary`);
    const rl = live(rs, (x) => x.attempt).filter((x) => String(x.attempt) === String(att));
    eq(rl.length, 1, `attempt ${att}: exactly one live review`);
    eq(rl[0].summary, expected[att][1], `attempt ${att} review summary`);
  }
  // The shifted hook lines are kept and point at the attempt their content belongs to.
  const stale = cs.filter((x) => x.stale_of != null).map((x) => [String(x.task.attempt), x.stale_of]);
  eq(JSON.stringify(stale), JSON.stringify([['2', '1'], ['3', '2']]), 'completions stale_of');
  eq(rs.filter((x) => x.stale_of != null).length, 2, 'review rows marked stale');
  // One step past: a second run changes nothing.
  const before = fs.readFileSync(path.join(logsOf(s.proj), 'completions.jsonl'), 'utf8');
  const beforeR = fs.readFileSync(path.join(logsOf(s.proj), 'reviews.jsonl'), 'utf8');
  reconcile(s);
  eq(fs.readFileSync(path.join(logsOf(s.proj), 'completions.jsonl'), 'utf8'), before, 'second run: completions unchanged');
  eq(fs.readFileSync(path.join(logsOf(s.proj), 'reviews.jsonl'), 'utf8'), beforeR, 'second run: reviews unchanged');
});

test('reconcile: --dry-run reports shifted lines but rewrites nothing', () => {
  const reports = [REVIEW('changes_requested', 'one'), REVIEW('approve', 'two')];
  const s = reconcileSetup('sh2', reports);
  appendLog(s.proj, 'completions.jsonl', [{ ts: 't', tool: 'claude', kind: 'completion', agent_id: 'sh2', task: { id: 'RC-1', attempt: 2 }, review: parsed(reports[0]) }]);
  const before = fs.readFileSync(path.join(logsOf(s.proj), 'completions.jsonl'), 'utf8');
  reconcile(s, ['--dry-run']);
  eq(fs.readFileSync(path.join(logsOf(s.proj), 'completions.jsonl'), 'utf8'), before, 'file untouched');
});

test('reconcile: backfilled lines keep the run guidance_version and add reconciled_by', () => {
  const s = reconcileSetup('gv1', [REVIEW('approve', 'ok')]);
  eq(readLog(s.proj, 'completions.jsonl').length, 0, 'precondition: nothing logged');
  reconcile(s);
  const [c] = readLog(s.proj, 'completions.jsonl');
  const [rev] = readLog(s.proj, 'reviews.jsonl');
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version;
  eq(c.guidance_version, '0.3.0', 'completion keeps the run version');
  eq(c.reconciled_by, version, 'completion reconciled_by');
  eq(rev.guidance_version, '0.3.0', 'review keeps the run version');
  eq(rev.reconciled_by, version, 'review reconciled_by');
  assert(version !== '0.3.0' && version !== 'unknown', `plugin version is distinct: ${version}`);
});

// G3: tier_mismatch

const delegate = (proj, prompt, ti = {}) => run('log-delegation.js', {
  hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: 'tu',
  tool_input: { prompt, subagent_type: 'agent-team:implementer', ...ti }, tool_response: {},
}, proj);

test('delegation: card tier differing from the tier that ran adds tier_mismatch and tells the Director', () => {
  const proj = tmpProject();
  const r = delegate(proj, 'TASK id=T-1 type=implement tier=small attempt=1');
  const [d] = readLog(proj, 'delegations.jsonl');
  eq(d.tier, 'medium', 'precondition: the spawn ran medium');
  eq(JSON.stringify(d.tier_mismatch), JSON.stringify({ card: 'small', ran: 'medium' }), 'tier_mismatch');
  const out = JSON.parse(r.stdout);
  eq(out.hookSpecificOutput.hookEventName, 'PostToolUse', 'event name');
  eq(out.hookSpecificOutput.additionalContext, 'agent-team: task card says tier small but the spawn ran tier medium', 'context');
});

test('delegation: matching tier, no tier on the card, and an unmapped card tier add nothing', () => {
  const proj = tmpProject();
  const same = delegate(proj, 'TASK id=T-1 type=implement tier=medium attempt=1');
  const none = delegate(proj, 'TASK id=T-2 type=implement attempt=1');
  eq(same.stdout, '', 'no output for a match');
  eq(none.stdout, '', 'no output without card tier');
  const ds = readLog(proj, 'delegations.jsonl');
  eq(ds.length, 2, 'precondition: both logged');
  assert(ds.every((d) => !('tier_mismatch' in d)), 'no tier_mismatch field');
});

// Stop hook nudge

test('stop hook: a role agent ending without its JSON block gets a nudge naming it; with the block, none', () => {
  const proj = tmpProject();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-team-tr-'));
  const bare = transcript(dir, 'nd1', ['all done, no block']);
  const r = stop(proj, bare, 'nd1', 'agent-team:reviewer');
  eq(readLog(proj, 'completions.jsonl').length, 1, 'precondition: completion logged');
  const ctx = JSON.parse(r.stdout).hookSpecificOutput;
  eq(ctx.hookEventName, 'SubagentStop', 'event name');
  assert(ctx.additionalContext.includes('agent-team:reviewer') && ctx.additionalContext.includes('nd1') && /ask it for the block/.test(ctx.additionalContext), ctx.additionalContext);
  // One step past: the same stop firing again logs and nudges nothing.
  eq(stop(proj, bare, 'nd1', 'agent-team:reviewer').stdout, '', 'repeat stop: no second nudge');
  const ok = transcript(dir, 'nd2', [REVIEW('approve', 'ok')]);
  eq(stop(proj, ok, 'nd2', 'agent-team:reviewer').stdout, '', 'block present: no nudge');
  const other = transcript(dir, 'nd3', ['no block']);
  eq(stop(proj, other, 'nd3', 'general-purpose').stdout, '', 'non-role agent: no nudge');
});
