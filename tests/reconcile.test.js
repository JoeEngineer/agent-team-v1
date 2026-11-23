// Tests for scripts/reconcile-logs.js. Loaded by tests/run.js.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { SCRIPTS, tmpProject, run, readLog, test, assert, eq } = require('./helpers');
const { spawnSync } = require('child_process');

const REVIEW = (v) => '```review-json\n{"verdict":"' + v + '","severity":"none","issues":[],"summary":"s"}\n```';
const CARD = (n) => `TASK id=RC-1 type=review difficulty=easy milestone=rc attempt=${n} pr=9`;
const usage = { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

// A session folder under a fake projects root holding one agent transcript.
function setup(agentId, turns, { sessionId = 'sess-1', writeTranscript = true } = {}) {
  const proj = tmpProject();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-team-projects-'));
  const dir = path.join(root, 'some-project-folder', sessionId, 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `agent-${agentId}.jsonl`);
  if (writeTranscript) {
    const lines = [];
    turns.forEach((report, i) => {
      const ts = (s) => `2026-10-30T1${i}:00:${s}.000Z`;
      lines.push({ type: 'user', isMeta: i > 0, timestamp: ts('00'), message: { role: 'user', content: CARD(i + 1) } });
      lines.push({ type: 'assistant', timestamp: ts('05'), message: { id: `m${i}`, model: 'claude-sonnet-5-5', usage, content: [{ type: 'tool_use', name: 'SubagentHandback', input: { message: report } }] } });
    });
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    fs.writeFileSync(file.replace(/\.jsonl$/, '.meta.json'), JSON.stringify({ agentType: 'agent-team:reviewer' }));
  }
  const delegation = { ts: 't', tool: 'claude', session_id: sessionId, kind: 'subagent', agent: 'agent-team:reviewer', agent_id: agentId, model: 'sonnet', effort: 'medium', tier: 'medium', background: true, task: { id: 'RC-1', type: 'review', attempt: '1', pr: '9' } };
  const logs = path.join(proj, '.agent-team', 'logs');
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(path.join(logs, 'delegations.jsonl'), JSON.stringify(delegation) + '\n' + 'not json\n');
  return { proj, root, file, logs };
}

const reconcile = (s, args = [], env = {}) =>
  spawnSync('node', [path.join(SCRIPTS, 'reconcile-logs.js'), ...args], {
    encoding: 'utf8',
    cwd: s.proj,
    env: { ...process.env, CLAUDE_PROJECT_DIR: s.proj, AGENT_TEAM_PROJECTS_ROOT: s.root, ...env },
  });

test('reconcile: a missed review is backfilled with its verdict and report_source reconcile; a second run adds nothing', () => {
  const s = setup('rc1', [REVIEW('changes_requested')]);
  eq(readLog(s.proj, 'completions.jsonl').length, 0, 'precondition: hook logged nothing');
  const r = reconcile(s);
  eq(r.status, 0, 'exit 0');
  assert(/1 completions backfilled/.test(r.stdout), `counts printed: ${r.stdout}`);
  const [c] = readLog(s.proj, 'completions.jsonl');
  eq(c.report_source, 'reconcile', 'report_source');
  eq(c.agent_id, 'rc1', 'agent id');
  eq(c.review.verdict, 'changes_requested', 'completion review');
  eq(c.tokens_with_cache, 3, 'tokens from the transcript');
  const [rev] = readLog(s.proj, 'reviews.jsonl');
  eq(rev.verdict, 'changes_requested', 'review line verdict');
  eq(rev.task_id, 'RC-1', 'review task id');
  reconcile(s);
  eq(readLog(s.proj, 'completions.jsonl').length, 1, 'second run: no new completion');
  eq(readLog(s.proj, 'reviews.jsonl').length, 1, 'second run: no new review');
});

test('reconcile: marker removed (pruned) still adds nothing, and a later hook fire adds nothing', () => {
  const s = setup('rc2', [REVIEW('approve')]);
  reconcile(s);
  fs.rmSync(path.join(s.logs, '.pending'), { recursive: true, force: true });
  reconcile(s);
  eq(readLog(s.proj, 'completions.jsonl').length, 1, 'content match keeps it idempotent without markers');
  // Re-create the markers via the hook's own key by reconciling fresh, then fire the hook.
  const s2 = setup('rc2b', [REVIEW('approve')]);
  reconcile(s2);
  run('log-delegation.js', { hook_event_name: 'SubagentStop', agent_id: 'rc2b', agent_type: 'agent-team:reviewer', agent_transcript_path: s2.file }, s2.proj);
  eq(readLog(s2.proj, 'completions.jsonl').length, 1, 'hook after reconcile adds nothing');
  eq(readLog(s2.proj, 'reviews.jsonl').length, 1, 'no second review');
});

test('reconcile: a completion the hook already logged is not duplicated', () => {
  const s = setup('rc3', [REVIEW('approve')]);
  run('log-delegation.js', { hook_event_name: 'SubagentStop', agent_id: 'rc3', agent_type: 'agent-team:reviewer', agent_transcript_path: s.file }, s.proj);
  eq(readLog(s.proj, 'completions.jsonl').length, 1, 'precondition: hook logged it');
  const r = reconcile(s);
  eq(readLog(s.proj, 'completions.jsonl').length, 1, 'no duplicate');
  assert(/0 completions backfilled, 1 already present/.test(r.stdout), r.stdout);
});

test('reconcile: a transcript that cannot be found is reported, not an error', () => {
  const s = setup('rc4', [], { writeTranscript: false });
  const r = reconcile(s);
  eq(r.status, 0, 'exit 0');
  assert(/1 transcript not found/.test(r.stdout), r.stdout);
  eq(readLog(s.proj, 'completions.jsonl').length, 0, 'nothing written');
});

test('reconcile: --dry-run writes nothing', () => {
  const s = setup('rc5', [REVIEW('approve')]);
  const r = reconcile(s, ['--dry-run']);
  assert(/would be backfilled/.test(r.stdout) && /1 would/.test(r.stdout), r.stdout);
  eq(readLog(s.proj, 'completions.jsonl').length, 0, 'no completion');
  eq(readLog(s.proj, 'reviews.jsonl').length, 0, 'no review');
  assert(!fs.existsSync(path.join(s.logs, '.pending')), 'no markers claimed');
  reconcile(s);
  eq(readLog(s.proj, 'completions.jsonl').length, 1, 'a real run after the dry run still backfills');
});

test('reconcile: a resumed agent gets one line per turn, each with its own verdict', () => {
  const s = setup('rc6', [REVIEW('changes_requested'), REVIEW('approve')]);
  const resume = { ts: 't', tool: 'claude', session_id: 'sess-1', kind: 'resume', agent: 'agent-team:reviewer', agent_id: 'rc6', task: { id: 'RC-1', type: 'review', attempt: '2', pr: '9' } };
  fs.appendFileSync(path.join(s.logs, 'delegations.jsonl'), JSON.stringify(resume) + '\n');
  reconcile(s);
  const cs = readLog(s.proj, 'completions.jsonl');
  eq(cs.length, 2, 'two completions');
  eq(cs[0].review.verdict, 'changes_requested', 'turn 1');
  eq(cs[1].review.verdict, 'approve', 'turn 2');
  eq(cs[1].task.attempt, '2', 'turn 2 task from the resume record');
  reconcile(s);
  eq(readLog(s.proj, 'completions.jsonl').length, 2, 'second run adds nothing');
});

test('reconcile: no projects folder (Codex-only install) exits 0 with a message; codex records are skipped', () => {
  const s = setup('rc7', [REVIEW('approve')]);
  const r = reconcile(s, [], { AGENT_TEAM_PROJECTS_ROOT: path.join(s.root, 'missing') });
  eq(r.status, 0, 'exit 0');
  assert(/nothing to reconcile/.test(r.stdout), r.stdout);
  const logs = path.join(s.logs, 'delegations.jsonl');
  fs.writeFileSync(logs, JSON.stringify({ tool: 'codex', kind: 'subagent', agent_id: 'rc7', session_id: 'sess-1', task: {} }) + '\n');
  const r2 = reconcile(s);
  eq(r2.status, 0, 'exit 0');
  eq(readLog(s.proj, 'completions.jsonl').length, 0, 'codex agent not backfilled');
});

test('reconcile: a resumed agent with identical reports on two turns gets both; dry-run agrees with the real run', () => {
  const s = setup('rc8', [REVIEW('approve'), REVIEW('approve')]);
  const resume = { ts: 't', tool: 'claude', session_id: 'sess-1', kind: 'resume', agent: 'agent-team:reviewer', agent_id: 'rc8', task: { id: 'RC-1', type: 'review', attempt: '2', pr: '9' } };
  fs.appendFileSync(path.join(s.logs, 'delegations.jsonl'), JSON.stringify(resume) + '\n');
  eq(readLog(s.proj, 'completions.jsonl').length, 0, 'precondition: nothing logged yet');
  const dry = reconcile(s, ['--dry-run']);
  assert(/2 would be backfilled/.test(dry.stdout), `dry-run counts both turns: ${dry.stdout}`);
  eq(readLog(s.proj, 'completions.jsonl').length, 0, 'dry-run wrote nothing');
  const real = reconcile(s);
  assert(/2 completions backfilled/.test(real.stdout), `real run counts both turns: ${real.stdout}`);
  const cs = readLog(s.proj, 'completions.jsonl');
  eq(cs.length, 2, 'both turns backfilled');
  eq(cs[1].task.attempt, '2', 'turn 2 is its own line');
  reconcile(s);
  eq(readLog(s.proj, 'completions.jsonl').length, 2, 'one step past: a second run adds nothing');
});

test('reconcile: Codex pending stops support dry-run and recovery without a Claude projects root', () => {
  const proj = tmpProject();
  const s = { proj, root: path.join(proj, 'no-claude-root') };
  const file = path.join(proj, 'child.jsonl');
  const ev = (type, payload) => JSON.stringify({ type, payload }) + '\n';
  fs.writeFileSync(file,
    ev('session_meta', { agent_path: '/root/rc_9_a1' }) +
    ev('event_msg', { type: 'task_started', turn_id: 'child-turn' }) +
    ev('turn_context', { turn_id: 'child-turn', model: 'actual-model', effort: 'low' }));
  const input = { hook_event_name: 'SubagentStop', session_id: 'parent', turn_id: 'child-turn', agent_id: 'child', agent_transcript_path: file, last_assistant_message: REVIEW('approve') };
  run('log-delegation.js', input, proj);
  eq(readLog(proj, 'completions.jsonl').length, 0, 'waiting for matching completion');
  const waiting = reconcile(s, ['--dry-run']);
  assert(/Codex: 0 would be backfilled.*1 pending/.test(waiting.stdout), waiting.stdout);
  fs.appendFileSync(file, ev('event_msg', { type: 'task_complete', turn_id: 'child-turn', duration_ms: 4321 }));
  const dry = reconcile(s, ['--dry-run']);
  assert(/Codex: 1 would be backfilled/.test(dry.stdout), dry.stdout);
  eq(readLog(proj, 'completions.jsonl').length, 0, 'dry-run did not write completion');
  eq(readLog(proj, 'reviews.jsonl').length, 0, 'dry-run did not write review');
  const real = reconcile(s);
  eq(real.status, 0, 'exit');
  assert(/Codex: 1 completions backfilled/.test(real.stdout), real.stdout);
  assert(/No Claude Code projects folder/.test(real.stdout), 'Codex recovery precedes missing-Claude message');
  const [c] = readLog(proj, 'completions.jsonl');
  eq(c.duration_ms, 4321, 'recovered current duration');
  eq(c.resolved_effort, 'low', 'observed effort recovered');
  eq(c.review.verdict, 'approve', 'frozen parsed report');
  eq(readLog(proj, 'reviews.jsonl').length, 1, 'separate review written');
  reconcile(s);
  run('log-delegation.js', input, proj);
  eq(readLog(proj, 'completions.jsonl').length, 1, 'reconcile and later duplicate callback are idempotent');
  eq(readLog(proj, 'reviews.jsonl').length, 1, 'review stays idempotent');
});

// --- G18: a turn that ran on after its completion line was written ---

const U = (input, output, cacheRead, cacheWrite) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite });
const entryUser = (text, meta = false) => ({ type: 'user', isMeta: meta, timestamp: '2026-11-01T10:00:00.000Z', message: { role: 'user', content: text } });
const entryAsst = (id, usage, content, ts = '2026-11-01T10:00:05.000Z') => ({ type: 'assistant', timestamp: ts, message: { id, model: 'claude-sonnet-5-5', usage, content } });
const handback = (report) => [{ type: 'tool_use', name: 'SubagentHandback', input: { message: report } }];
const lineOf = (c) => JSON.stringify(c) + '\n';

// A project with carded Claude agents. agents: [{ id, entries, comps: [{ turn, tokens, ... }], tool, carded }].
function setupAgents(agents) {
  const proj = tmpProject();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-team-projects-'));
  const dir = path.join(root, 'some-project-folder', 'sess-1', 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  const logs = path.join(proj, '.agent-team', 'logs');
  let delegations = '';
  let completions = '';
  let reviews = '';
  for (const a of agents) {
    if (a.entries) fs.writeFileSync(path.join(dir, `agent-${a.id}.jsonl`), a.entries.map(lineOf).join(''));
    const task = a.carded === false ? {} : { id: 'RC-1', type: 'review', attempt: '1', pr: '9' };
    delegations += lineOf({ ts: 't', tool: a.tool || 'claude', session_id: 'sess-1', kind: 'subagent', agent: 'agent-team:reviewer', agent_id: a.id, model: 'sonnet', task });
    for (const c of a.comps || []) {
      const review = { verdict: 'approve', severity: 'none', issues: [], summary: 's' };
      completions += lineOf({ ts: 't1', tool: a.tool || 'claude', session_id: 'sess-1', kind: 'completion', agent: 'agent-team:reviewer', agent_id: a.id, model: 'sonnet', turn: c.turn, task: { ...task, attempt: String(c.turn) },
        duration_ms: 5000, tokens_with_cache: c.tokens, tokens_by_class: c.classes || null, report_source: 'handback', result: null, review, ...(c.extra || {}) });
      reviews += lineOf({ ts: 't1', task_id: 'RC-1', agent_id: a.id, ...review });
    }
  }
  fs.writeFileSync(path.join(logs, 'delegations.jsonl'), delegations);
  fs.writeFileSync(path.join(logs, 'completions.jsonl'), completions);
  fs.writeFileSync(path.join(logs, 'reviews.jsonl'), reviews);
  return { proj, root, logs };
}

// Turn 1 handed back (135 tokens: the completion line's total), then a background-task wake-up cost 255 more.
const WAKE_UP = [
  entryUser(CARD(1)),
  entryAsst('m0', U(10, 20, 100, 5), handback(REVIEW('approve'))),
  { type: 'attachment', timestamp: '2026-11-01T10:01:00.000Z', attachment: { type: 'task_notification' } },
  entryUser('<task-notification>background command finished</task-notification>', true),
  entryAsst('m1', U(5, 50, 200, 0), [{ type: 'text', text: 'the agent has now fully stopped; that changes nothing' }], '2026-11-01T10:01:05.000Z'),
];
// The enforce-nudge case (SR-6 attempt 2): the first stop ended without the hand-back tool, the hook logged the line, the nudge sent the agent round again.
const NUDGED = [
  entryUser(CARD(1)),
  entryAsst('n0', U(10, 20, 100, 5), [{ type: 'text', text: REVIEW('approve') }]),
  entryUser('[handback-send-enforce] Your report has not been delivered. Call SubagentHandback({message: <your full report>}).', true),
  entryAsst('n1', U(7, 30, 150, 0), handback(REVIEW('approve')), '2026-11-01T10:00:09.000Z'),
];
const CLASSES_135 = { input: 10, output: 20, cache_read: 100, cache_write: 5 };

test('reconcile G18: a wake-up after the hand-back gets one superseding line with the full turn tokens and no second review row', () => {
  const s = setupAgents([{ id: 'wk1', entries: WAKE_UP, comps: [{ turn: 1, tokens: 135, classes: CLASSES_135 }] }]);
  const before = readLog(s.proj, 'completions.jsonl');
  eq(before.length, 1, 'precondition: the hook wrote its line');
  eq(before[0].tokens_with_cache, 135, 'precondition: the line holds only the tokens up to the hand-back');
  const r = reconcile(s);
  eq(r.status, 0, r.stderr);
  assert(/1 completion line superseded/.test(r.stdout), r.stdout);
  const cs = readLog(s.proj, 'completions.jsonl');
  eq(cs.length, 2, 'one superseding line');
  eq(JSON.stringify(cs[0]), JSON.stringify(before[0]), 'the first line is untouched');
  eq(cs[1].tokens_with_cache, 390, 'the full turn: 135 + 255');
  eq(JSON.stringify(cs[1].tokens_by_class), JSON.stringify({ input: 15, output: 70, cache_read: 300, cache_write: 5 }), 'classes');
  eq(cs[1].agent_id, 'wk1', 'same agent');
  eq(cs[1].turn, 1, 'same turn');
  eq(cs[1].review.verdict, 'approve', 'the verdict travels with the line');
  assert(/^\d+\.\d+\.\d+/.test(cs[1].reconciled_by), `reconciled_by set: ${cs[1].reconciled_by}`);
  eq(readLog(s.proj, 'reviews.jsonl').length, 1, 'no second reviews.jsonl row');
  // one step past: nothing is superseded again
  const r2 = reconcile(s);
  assert(!/superseded/.test(r2.stdout), r2.stdout);
  eq(readLog(s.proj, 'completions.jsonl').length, 2, 'a rerun adds nothing');
  eq(readLog(s.proj, 'reviews.jsonl').length, 1, 'still one review row');
});

test('reconcile G18: the enforce-nudge turn (hook line written before the nudge) is superseded', () => {
  const s = setupAgents([{ id: 'nd1', entries: NUDGED, comps: [{ turn: 1, tokens: 135, classes: CLASSES_135, extra: { report_source: 'hook-input' } }] }]);
  eq(readLog(s.proj, 'completions.jsonl')[0].tokens_with_cache, 135, 'precondition: the line is short of the nudge turn');
  reconcile(s);
  const cs = readLog(s.proj, 'completions.jsonl');
  eq(cs.length, 2, 'one superseding line');
  eq(cs[1].tokens_with_cache, 135 + 187, 'the nudge turn tokens are included');
  eq(cs[1].report_source, 'hook-input', 'the line keeps what it supersedes');
  reconcile(s);
  eq(readLog(s.proj, 'completions.jsonl').length, 2, 'a rerun adds nothing');
});

test('reconcile G18: a turn already complete, a duplicate message id and an agent with no line add nothing', () => {
  // the same message id repeated across entries counts once: 135, not 270
  const dup = [entryUser(CARD(1)), entryAsst('d0', U(10, 20, 100, 5), handback(REVIEW('approve'))), entryAsst('d0', U(10, 20, 100, 5), handback(REVIEW('approve')))];
  const s = setupAgents([
    { id: 'eq1', entries: dup, comps: [{ turn: 1, tokens: 135, classes: CLASSES_135 }] },
    { id: 'nl1', entries: WAKE_UP, comps: [] },
  ]);
  const r = reconcile(s);
  eq(r.status, 0, r.stderr);
  assert(!/superseded/.test(r.stdout), r.stdout);
  const cs = readLog(s.proj, 'completions.jsonl');
  eq(cs.filter((c) => c.agent_id === 'eq1').length, 1, 'equal totals: eq1 is not superseded');
  // nl1 had no line: the ordinary backfill writes it, already with the full turn (390), so there is nothing to supersede
  const nl = cs.filter((c) => c.agent_id === 'nl1');
  eq(nl.length, 1, 'nl1: one backfilled line');
  eq(nl[0].report_source, 'reconcile', 'written by the backfill');
  eq(nl[0].tokens_with_cache, 390, 'the backfill already holds the whole turn');
});

test('reconcile G18: only the turn that ran on is superseded; the last line of a turn is the one compared; stale lines are ignored', () => {
  const entries = [
    entryUser(CARD(1)), entryAsst('t0', U(10, 20, 100, 5), handback(REVIEW('approve'))),
    entryUser(CARD(2), true), entryAsst('t1', U(1, 1, 1, 1), handback(REVIEW('approve'))),
    entryAsst('t2', U(2, 2, 2, 2), [{ type: 'text', text: 'woken' }]),
  ];
  const s = setupAgents([{ id: 'rs1', entries, comps: [
    { turn: 1, tokens: 135, classes: CLASSES_135 },
    { turn: 2, tokens: 4 },
    { turn: 2, tokens: 8, classes: { input: 3, output: 3, cache_read: 3, cache_write: 2 } }, // an interim line, then the last one
    { turn: 2, tokens: 999, extra: { stale_of: '1' } }, // a stale line must not hide the shortfall
  ] }]);
  const resume = { ts: 't', tool: 'claude', session_id: 'sess-1', kind: 'resume', agent: 'agent-team:reviewer', agent_id: 'rs1', task: { id: 'RC-1', type: 'review', attempt: '2', pr: '9' } };
  fs.appendFileSync(path.join(s.logs, 'delegations.jsonl'), lineOf(resume));
  eq(readLog(s.proj, 'completions.jsonl').length, 4, 'precondition: four lines');
  reconcile(s);
  const cs = readLog(s.proj, 'completions.jsonl');
  eq(cs.length, 5, 'one new line');
  eq(cs[4].turn, 2, 'turn 2');
  eq(cs[4].tokens_with_cache, 12, 'turn 2 only: 4 + 8 (turn 1 is not included)');
  reconcile(s);
  eq(readLog(s.proj, 'completions.jsonl').length, 5, 'a rerun adds nothing');
});

test('reconcile G18: --dry-run reports and writes nothing; a Codex agent and an uncarded agent are skipped', () => {
  const s = setupAgents([
    { id: 'dr1', entries: WAKE_UP, comps: [{ turn: 1, tokens: 135, classes: CLASSES_135 }] },
    { id: 'cx1', entries: WAKE_UP, tool: 'codex', comps: [{ turn: 1, tokens: 135 }] },
    { id: 'uc1', entries: WAKE_UP, carded: false, comps: [{ turn: 1, tokens: 135 }] },
  ]);
  const dry = reconcile(s, ['--dry-run']);
  assert(/1 completion line would be superseded/.test(dry.stdout), dry.stdout);
  eq(readLog(s.proj, 'completions.jsonl').length, 3, 'dry run wrote nothing');
  reconcile(s);
  const cs = readLog(s.proj, 'completions.jsonl');
  eq(cs.length, 4, 'only the carded Claude agent was superseded');
  eq(cs[3].agent_id, 'dr1', 'which one');
});

test('reconcile G18: each transcript is read once per run, however many turns it has', () => {
  const entries = [
    entryUser(CARD(1)), entryAsst('r0', U(10, 20, 100, 5), handback(REVIEW('approve'))),
    entryUser(CARD(2), true), entryAsst('r1', U(1, 1, 1, 1), handback(REVIEW('approve'))),
    entryAsst('r2', U(2, 2, 2, 2), [{ type: 'text', text: 'woken' }]),
  ];
  const s = setupAgents([
    { id: 'rd1', entries, comps: [{ turn: 1, tokens: 135 }, { turn: 2, tokens: 4 }] },
    { id: 'rd2', entries: WAKE_UP, comps: [{ turn: 1, tokens: 135 }] },
    { id: 'rd3', entries: NUDGED, comps: [{ turn: 1, tokens: 135 }] },
  ]);
  const resume = { ts: 't', tool: 'claude', session_id: 'sess-1', kind: 'resume', agent: 'agent-team:reviewer', agent_id: 'rd1', task: { id: 'RC-1', type: 'review', attempt: '2', pr: '9' } };
  fs.appendFileSync(path.join(s.logs, 'delegations.jsonl'), lineOf(resume));
  const saved = { CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR, AGENT_TEAM_PROJECTS_ROOT: process.env.AGENT_TEAM_PROJECTS_ROOT };
  const realRead = fs.readFileSync;
  const reads = {};
  process.env.CLAUDE_PROJECT_DIR = s.proj;
  process.env.AGENT_TEAM_PROJECTS_ROOT = s.root;
  fs.readFileSync = function (f, ...rest) {
    if (typeof f === 'string' && /agent-rd\d\.jsonl$/.test(f)) reads[path.basename(f)] = (reads[path.basename(f)] || 0) + 1;
    return realRead.call(this, f, ...rest);
  };
  let stats;
  try { stats = require(path.join(SCRIPTS, 'reconcile-logs.js')).reconcile(); } finally {
    fs.readFileSync = realRead;
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  eq(stats.superseded, 3, 'precondition: all three agents ran on, so the supersede step used each transcript');
  eq(JSON.stringify(reads), JSON.stringify({ 'agent-rd1.jsonl': 1, 'agent-rd2.jsonl': 1, 'agent-rd3.jsonl': 1 }), 'one file read per agent');
  eq(stats.reads, 3, 'the cache counts the same');
});

test('reconcile: scanTranscript agrees with readSubagentTranscript turn by turn (one read against one read per turn)', () => {
  const { scanTranscript } = require(path.join(SCRIPTS, 'reconcile-logs.js'));
  const { readSubagentTranscript } = require(path.join(SCRIPTS, 'log-delegation.js'));
  const entries = [
    entryUser(CARD(1)), entryAsst('p0', U(10, 20, 100, 5), [{ type: 'text', text: 'one ' }]), entryAsst('p0', U(10, 20, 100, 5), [{ type: 'text', text: 'two' }]),
    entryAsst('p1', U(1, 2, 3, 4), handback('report 1')),
    { type: 'attachment', timestamp: '2026-11-01T10:00:30.000Z' }, entryUser('[handback-send-enforce] nudge', true),
    entryUser(CARD(2), true), entryAsst('p2', U(2, 2, 2, 2), handback('report 2')), entryAsst('p1', U(9, 9, 9, 9), []),
    entryUser(CARD(3), true), entryAsst('p3', U(3, 3, 3, 3), [{ type: 'text', text: 'last words' }]),
  ];
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-team-scan-')), 'agent-x.jsonl');
  fs.writeFileSync(file, entries.map(lineOf).join('') + 'torn line {\n');
  const scan = scanTranscript(file);
  eq(scan.turn, 3, 'three turns');
  for (let n = 1; n <= 3; n++) {
    const a = scan.turns[n - 1];
    const b = readSubagentTranscript(file, n);
    for (const k of ['turn', 'tokens', 'handback', 'lastText', 'first', 'last', 'model', 'lastId', 'prompt']) eq(JSON.stringify(a[k]), JSON.stringify(b[k]), `turn ${n} ${k}`);
    eq(JSON.stringify(a.classes), JSON.stringify(b.classes), `turn ${n} classes`);
    eq(JSON.stringify(a.task), JSON.stringify(b.task), `turn ${n} task`);
  }
  eq(scan.turns[0].tokens, 135 + 10, 'turn 1: p0 once, p1 once');
});
